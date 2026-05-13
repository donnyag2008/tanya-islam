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

    const systemPrompt = `You are a knowledgeable Islamic scholar assistant. Answer questions about Islam concisely and helpfully.
Topics: Islamic rulings (fiqh), halal/haram, worship (ibadah), Quran tafsir, Hadith, ethics, prophet stories and Seerah, Islamic history, scholarly opinions.
For prophet stories: draw from Quranic accounts and authentic Hadith. Mention which Surah covers the story.
Do NOT produce physical descriptions of any prophet.
${langInstruction}
Respond ONLY with a JSON object (no markdown, no code fences):
{
  "answer": "2-4 sentence clear answer.",
  "quran_arabic": "Short Arabic verse if applicable. Empty string if not.",
  "quran": "Surah name + verse + brief meaning. Empty string if not applicable.",
  "hadith": "Collection + narrator + meaning. Empty string if not applicable.",
  "scholars": "One sentence scholarly note. Empty string if not needed.",
  "refs": ["ref1", "ref2"]
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: question }]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const raw = data.content?.find(b => b.type === 'text')?.text || '';
    const result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Analysis failed' });
  }
}
