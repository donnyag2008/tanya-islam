const https = require('https');

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const question = body.question;
    const lang = body.lang || 'en';

    if (!question) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing question' }) };
    }

    const langInstruction = lang === 'id'
      ? 'Jawab dalam Bahasa Indonesia yang baik dan mudah dipahami.'
      : 'Answer in clear, simple English.';

    const systemPrompt = 'You are a knowledgeable Islamic scholar assistant. Answer questions about Islam concisely. Topics: Islamic rulings, halal/haram, worship, Quran, Hadith, prophet stories and Seerah, Islamic history. Do NOT describe prophets physically. ' + langInstruction + ' Respond ONLY with a JSON object (no markdown): {"answer":"2-4 sentence answer","quran_arabic":"Arabic verse or empty string","quran":"Surah reference or empty string","hadith":"Hadith reference or empty string","scholars":"Scholar opinion or empty string","refs":["ref1"]}';

    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: question }]
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(requestBody)
        }
      };

      const req = https.request(options, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch(e) { reject(new Error('Failed to parse response')); }
        });
      });

      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    if (result.error) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: result.error.message }) };
    }

    const raw = result.content?.find(b => b.type === 'text')?.text || '';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return { statusCode: 200, headers, body: JSON.stringify(parsed) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Analysis failed' }) };
  }
};
