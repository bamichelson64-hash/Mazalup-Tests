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

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    res.sendStatus(200);
    console.log('Webhook received:', new Date().toISOString());

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

    if (message.type === 'text') {
      extractedText = message.text.body;
      console.log('Text message received:', extractedText);
    } else if (message.type === 'document' && message.document.mime_type === 'application/pdf') {
      console.log('PDF document received, downloading...');
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

    console.log('Calling Claude API...');
    const extractedData = await extractDataWithClaude(extractedText);

    if (extractedData) {
      console.log('Data extracted:', extractedData);
      
      if (Array.isArray(extractedData)) {
        for (const transfer of extractedData) {
          await saveToGoogleSheets(transfer);
        }
        console.log(`Saved ${extractedData.length} transfers to Google Sheets`);
      } else {
        await saveToGoogleSheets(extractedData);
        console.log('Data saved successfully to Google Sheets');
      }
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
        max_tokens: 3000,
        messages: [
          {
            role: 'user',
            content: `You are extracting Argentine bank transfer information. Be VERY careful with formatting and multiple transfers.

CRITICAL RULES:

1. AMOUNT PARSING:
   - "1m" or "1M" → 1000000
   - "8m" → 8000000
   - "2.5m" → 2500000
   - "$8,765,000" → 8765000 (remove $ , and .)
   - "$2.500.000m" → 2500000
   - Always return raw number only

2. MULTIPLE TRANSFERS:
   - If message says "Girar en X giros" or has numbered amounts like:
     1) 8.765.000
     2) 7.623.000
     3) 7.745.753
   - Create SEPARATE transfer objects for EACH amount
   - Each should have the SAME account details but DIFFERENT amounts
   - Return as JSON ARRAY: [transfer1, transfer2, transfer3]

3. TIPO DE GIRO (IMPORTANT):
   - If contains "factura" or "con factura" → "Con Factura"
   - Otherwise → "Barrani" (default)
   - NEVER use both - it's either "Barrani" OR "Con Factura", not both

4. CUIT/DNI: Extract only numbers, remove dashes/spaces/dots
   - "30-71429017-3" → "3071429017"
   - "20-45.317.732-8" → "20453177328"

5. NAME PRIORITY:
   - Look for: Titular, Razón Social, or just a name
   - If no name, use Alias as identifier

6. BANK: Extract bank name (Galicia, BBVA, Santander, Provincia, Macro, etc.)

For SINGLE transfer, return JSON object:
{
  "tipo_giro": "Barrani" or "Con Factura" (default "Barrani"),
  "client_name": string,
  "bank": string,
  "amount": number,
  "alias": string,
  "sucursal": string,
  "time": string,
  "date": string,
  "transaction_number": string,
  "sender_name": string,
  "sender_cuit": string,
  "sender_account": string,
  "recipient_cbu": string,
  "recipient_dni": string,
  "accreditation_date": string,
  "reference": string,
  "motive": string,
  "recipient_name": string,
  "recipient_cuit": string
}

For MULTIPLE transfers, return JSON ARRAY:
[
  { ...transfer1 with amount1... },
  { ...transfer2 with amount2... },
  { ...transfer3 with amount3... }
]

Text:
${text}

Return ONLY valid JSON (object or array), no markdown.`
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
    
    const jsonText = claudeResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    if (jsonText === 'null' || jsonText === '') {
      return null;
    }

    const data = JSON.parse(jsonText);
    
    const ensureSingleType = (transfer) => {
      if (!transfer.tipo_giro || transfer.tipo_giro === 'null') {
        transfer.tipo_giro = 'Barrani';
      }
      if (transfer.tipo_giro && transfer.tipo_giro.includes('Con Factura')) {
        transfer.tipo_giro = 'Con Factura';
      } else {
        transfer.tipo_giro = 'Barrani';
      }
      return transfer;
    };
    
    if (Array.isArray(data)) {
      return data.filter(t => t.amount || t.recipient_name || t.client_name)
                 .map(ensureSingleType);
    } else if (data && (data.amount || data.recipient_name || data.client_name)) {
      return ensureSingleType(data);
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
    
    const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
    
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // REORGANIZED COLUMN ORDER
    const values = [[
      new Date().toISOString(),         // A: Timestamp
      data.tipo_giro || '',             // B: Tipo de Giro
      data.client_name || '',           // C: Client Name
      data.bank || '',                  // D: Bank
      data.amount || '',                // E: Amount (moved up)
      data.alias || '',                 // F: Alias (moved up)
      data.sucursal || '',              // G: Sucursal
      data.time || '',                  // H: Time
      data.date || '',                  // I: Date
      data.transaction_number || '',    // J: Transaction #
      data.sender_name || '',           // K: Sender Name
      data.sender_cuit || '',           // L: Sender CUIT
      data.sender_account || '',        // M: Sender Account
      data.recipient_cbu || '',         // N: Recipient CBU
      data.recipient_dni || '',         // O: Recipient DNI
      data.accreditation_date || '',    // P: Accreditation Date
      data.reference || '',             // Q: Reference
      data.motive || '',                // R: Motive
      data.recipient_name || '',        // S: Recipient Name (moved to end)
      data.recipient_cuit || ''         // T: Recipient CUIT (moved to end)
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: 'Sheet1!A:T',
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

app.get('/', (req, res) => {
  res.send('WhatsApp Transfer Tracker is running!');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
```

**Update your Google Sheet headers (Row 1) to match new order:**
```
A: Timestamp
B: Tipo de Giro
C: Client Name
D: Bank
E: Amount
F: Alias
G: Sucursal
H: Time
I: Date
J: Transaction #
K: Sender Name
L: Sender CUIT
M: Sender Account
N: Recipient CBU
O: Recipient DNI
P: Accreditation Date
Q: Reference
R: Motive
S: Recipient Name
T: Recipient CUIT
