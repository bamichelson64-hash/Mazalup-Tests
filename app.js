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
            content: `You are extracting Argentine bank transfer information. This is a request to SEND money TO the account provided.

CRITICAL RULES:

1. AMOUNT PARSING:
   - "1m" or "1M" → 1000000
   - "8m" → 8000000
   - "2.5m" → 2500000
   - "$8,765,000" → 8765000 (remove $ , and .)
   - "$2.500.000m" → 2500000
   - "Girar $305,000" → 305000
   - Always return raw number only

2. MULTIPLE TRANSFERS:
   - If message says "Girar en X giros" or numbered amounts:
     1) 8.765.000
     2) 7.623.000
   - Create SEPARATE transfer objects for EACH amount
   - Same account details, different amounts
   - Return as JSON ARRAY

3. TIPO DE GIRO:
   - If contains "factura" or "con factura" → "Con Factura"
   - Otherwise → "Barrani" (default)
   - NEVER both

4. ACCOUNT INFORMATION:
   - Name: "Titular" or "Razón Social"
   - CUIT: From "CUIL/CUIT/CDI", numbers only
   - DNI: From "Documento" or "DNI", numbers only
   - CBU: Account number
   - Alias: Account alias
   - Bank: Bank name
   - Account: "Cuenta" number if present

5. CLEAN NUMBERS: Remove dashes, spaces, dots
   - "30-71429017-3" → "3071429017"
   - "20-45.317.732-8" → "20453177328"

Return JSON:
{
  "tipo_giro": "Barrani" or "Con Factura",
  "nombre": string,
  "banco": string,
  "monto": number,
  "alias": string,
  "cuit": string,
  "dni": string,
  "cbu": string,
  "cuenta": string,
  "sucursal": string,
  "hora": string,
  "fecha": string,
  "numero_transaccion": string,
  "fecha_acreditacion": string,
  "referencia": string,
  "motivo": string
}

For multiple transfers, return array.

Text:
${text}

Return ONLY valid JSON, no markdown.`
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
      return data.filter(t => t.monto || t.nombre)
                 .map(ensureSingleType);
    } else if (data && (data.monto || data.nombre)) {
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

    const values = [[
      new Date().toISOString(),         // A: Marca de Tiempo
      data.tipo_giro || '',             // B: Tipo de Giro
      data.nombre || '',                // C: Nombre
      data.banco || '',                 // D: Banco
      data.monto || '',                 // E: Monto
      data.alias || '',                 // F: Alias
      data.cuit || '',                  // G: CUIT
      data.dni || '',                   // H: DNI
      data.cbu || '',                   // I: CBU
      data.cuenta || '',                // J: Cuenta
      data.sucursal || '',              // K: Sucursal
      data.hora || '',                  // L: Hora
      data.fecha || '',                 // M: Fecha
      data.numero_transaccion || '',    // N: Número de Transacción
      data.fecha_acreditacion || '',    // O: Fecha de Acreditación
      data.referencia || '',            // P: Referencia
      data.motivo || ''                 // Q: Motivo
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: 'Sheet1!A:Q',
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
