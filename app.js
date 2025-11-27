const express = require('express');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'mazalup_verify_token_2025';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT; // JSON string

// Webhook verification endpoint
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook to receive messages
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Respond immediately to Meta
    res.sendStatus(200);

    // Check if it's a WhatsApp message
    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;

      if (messages && messages.length > 0) {
        for (const message of messages) {
          await processMessage(message, value);
        }
      }
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
  }
});

async function processMessage(message, value) {
  try {
    console.log('Processing message:', message.id);

    let extractedText = '';

    // Handle different message types
    if (message.type === 'text') {
      extractedText = message.text.body;
    } else if (message.type === 'document' && message.document.mime_type === 'application/pdf') {
      // Download and extract PDF
      const pdfUrl = await getMediaUrl(message.document.id);
      const pdfBuffer = await downloadMedia(pdfUrl);
      const pdfData = await pdfParse(pdfBuffer);
      extractedText = pdfData.text;
    } else if (message.type === 'image') {
      // For images, we'd need OCR - skipping for now
      console.log('Image messages not yet supported');
      return;
    } else {
      console.log('Unsupported message type:', message.type);
      return;
    }

    // Extract data using Claude
    const extractedData = await extractDataWithClaude(extractedText);

    if (extractedData) {
      // Save to Google Sheets
      await saveToGoogleSheets(extractedData);
      console.log('Data saved successfully:', extractedData);
    } else {
      console.log('No transfer data found in message');
    }
  } catch (error) {
    console.error('Error processing message:', error);
  }
}

async function getMediaUrl(mediaId) {
  try {
    const response = await axios.get(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`
        }
      }
    );
    return response.data.url;
  } catch (error) {
    console.error('Error getting media URL:', error);
    throw error;
  }
}

async function downloadMedia(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`
      },
      responseType: 'arraybuffer'
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error('Error downloading media:', error);
    throw error;
  }
}

async function extractDataWithClaude(text) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `Extract bank transfer information from the following text. Return ONLY a valid JSON object with these fields (use null if not found):
- amount (number, without currency symbols or dots/commas)
- cuit (string, the CUIT/CUIL number)
- recipient_name (string)
- date (string in format DD/MM/YYYY)
- transaction_number (string)
- cbu (string, the bank account number)

If this is not a bank transfer message, return null.

Text:
${text}

Return ONLY the JSON object, nothing else.`
          }
        ]
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );

    const claudeResponse = response.data.content[0].text.trim();
    
    // Remove markdown code blocks if present
    const jsonText = claudeResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    if (jsonText === 'null' || jsonText === '') {
      return null;
    }

    const data = JSON.parse(jsonText);
    
    // Validate that we have at least amount and CUIT
    if (data && (data.amount || data.cuit)) {
      return data;
    }
    
    return null;
  } catch (error) {
    console.error('Error extracting data with Claude:', error.response?.data || error.message);
    return null;
  }
}

async function saveToGoogleSheets(data) {
  try {
    // Parse the service account credentials
    const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
    
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheets = google.sheets({ version: 'v4', auth });

    const values = [[
      new Date().toISOString(), // Timestamp
      data.date || '',
      data.amount || '',
      data.cuit || '',
      data.recipient_name || '',
      data.transaction_number || '',
      data.cbu || ''
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: 'Sheet1!A:G', // Adjust sheet name if needed
      valueInputOption: 'USER_ENTERED',
      resource: { values }
    });

    console.log('Successfully appended to Google Sheets');
  } catch (error) {
    console.error('Error saving to Google Sheets:', error);
    throw error;
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.send('WhatsApp Transfer Tracker is running!');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
```

## File 3: `.env.example`
```
PORT=3000
VERIFY_TOKEN=mazalup_verify_token_2025
ANTHROPIC_API_KEY=your_anthropic_api_key_here
WHATSAPP_TOKEN=your_whatsapp_access_token_here
GOOGLE_SHEETS_ID=your_google_sheet_id_here
GOOGLE_SERVICE_ACCOUNT={"type":"service_account","project_id":"..."}
