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
const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT;

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

    console.log('Webhook received:', new Date().toISOString());

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
      console.log('Text message received:', extractedText);
    } else if (message.type === 'document' && message.document.mime_type === 'application/pdf') {
      console.log('PDF document received, downloading...');
      // Download and extract PDF
      const pdfUrl = await getMediaUrl(message.document.id);
      const pdfBuffer = await downloadMedia(pdfUrl);
      const pdfData = await pdfParse(pdfBuffer);
      extractedText = pdfData.text;
      console.log('PDF text extracted');
    } else if (message.type === 'image') {
      console.log('Image messages not yet supported');
      return;
    } else {
      console.log('Unsupported message type:', message.type);
      return;
    }

    // Extract data using Claude
    console.log('Calling Claude API...');
    const extractedData = await extractDataWithClaude(extractedText);

    if (extractedData) {
      console.log('Data extracted:', extractedData);
      // Save to Google Sheets
      await saveToGoogleSheets(extractedData);
      console.log('Data saved successfully to Google Sheets');
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
        max_tokens: 1500,
        messages: [
          {
            role: 'user',
            content: `Extract ALL bank transfer information from the following text. Return ONLY a valid JSON object with these fields (use null if not found):

- time (string, transaction time in HH:MM:SS format if available)
- date (string, transaction date in DD/MM/YYYY format)
- amount (number, the importe/amount without currency symbols, dots, or commas - just the raw number)
- transaction_number (string, número de transacción)
- sender_name (string, name from "Titular" field)
- sender_cuit (string, CUIT number from "Titular" field, just the numbers)
- sender_account (string, Cuenta a debitar)
- recipient_name (string, name from "Titular cuenta destino" field)
- recipient_cuit (string, CUIT/CUIL/DNI from "Titular cuenta destino" field, just the numbers)
- recipient_cbu (string, Cuenta destino / CBU number)
- recipient_alias (string, Alias if present)
- recipient_dni (string, DNI if present separately, just the numbers)
- accreditation_date (string, Fecha de acreditación in DD/MM/YYYY format)
- reference (string, Referencia field)
- motive (string, Motivo field)

Important notes:
- For amounts: remove all dots, commas, and currency symbols. Example: "$72.100.000,00" becomes 72100000
- For CUIT/DNI: extract just the numbers. Example: "20190314716" or "18367622"
- Look for Alias in the text (e.g., "Alias: Seto1967")
- If the text is not a bank transfer, return null

Text:
${text}

Return ONLY the JSON object, nothing else. Do not include any markdown formatting.`
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
    console.log('Claude response:', claudeResponse);
    
    // Remove markdown code blocks if present
    const jsonText = claudeResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    if (jsonText === 'null' || jsonText === '') {
      return null;
    }

    const data = JSON.parse(jsonText);
    
    // Validate that we have at least some transfer data
    if (data && (data.amount || data.transaction_number || data.sender_name || data.recipient_name)) {
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
    console.log('Saving to Google Sheets...');
    
    // Parse the service account credentials
    const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
    
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheets = google.sheets({ version: 'v4', auth });

    const values = [[
      new Date().toISOString(), // Timestamp when received
      data.time || '',
      data.date || '',
      data.amount || '',
      data.transaction_number || '',
      data.sender_name || '',
      data.sender_cuit || '',
      data.sender_account || '',
      data.recipient_name || '',
      data.recipient_cuit || '',
      data.recipient_cbu || '',
      data.recipient_alias || '',
      data.recipient_dni || '',
      data.accreditation_date || '',
      data.reference || '',
      data.motive || ''
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: 'Sheet1!A:P',
      valueInputOption: 'USER_ENTERED',
      resource: { values }
    });

    console.log('Successfully appended to Google Sheets');
  } catch (error) {
    console.error('Error saving to Google Sheets:', error.message);
    if (error.response) {
      console.error('Error details:', error.response.data);
    }
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
```javascript
});
```
