const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { question, lang } = req.body;
    if (!question) return res.status(400).json({ error: 'Missing question' });

    const langInstruction = lang === 'id'
      ? 'Jawab dalam Bahasa Indonesia yang baik dan mudah dipahami.'
      : 'Answer in clear, simple English.';

    const systemPrompt = `You are a knowledgeable Islamic scholar assistant. Answer questions about Islam concisely and helpfully. Topics: Islamic rulings (fiqh), halal/haram, worship, Quran tafsir, Hadith, ethics, prophet stories and Seerah, Islamic history, scholarly opinions. For prophet stories draw from Quranic accounts and Hadith. Do NOT describe prophets physically. ${langInstruction} Respond ONLY with a JSON object (no markdown, no code fences): {"answer":"2-4 sentence answer","quran_arabic":"Arabic verse or empty string","quran":"Surah reference or empty string","hadith":"Hadith reference or empty string","scholars":"Scholar opinion or empty string","refs":["ref1","ref2"]}`;

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

    if (result.error) return res.status(500).json({ error: result.error.message });

    const raw = result.content?.find(b => b.type === 'text')?.text || '';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Analysis failed' });
  }
}
