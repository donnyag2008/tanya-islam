const https = require('https');

// ---------- generic HTTPS JSON helper ----------
function httpsJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse response from ' + options.hostname)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------- call Claude ----------
async function callClaude(system, userText, maxTokens) {
  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    system: system,
    messages: [{ role: 'user', content: userText }]
  });

  const result = await httpsJson({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(requestBody)
    }
  }, requestBody);

  if (result.error) throw new Error(result.error.message);
  return result.content?.find(b => b.type === 'text')?.text || '';
}

// ---------- step 1: extract a short English search keyword/phrase ----------
async function extractKeyword(question) {
  const sys = 'Extract the single best English search keyword or short phrase (2-4 words max) ' +
    'that would find relevant Quran verses and Hadith about this Islamic question, regardless of what language the question is in. ' +
    'Respond with ONLY the keyword phrase, nothing else, no punctuation, no explanation.';
  const raw = await callClaude(sys, question, 30);
  return raw.trim().replace(/^["']|["']$/g, '');
}

// ---------- fallback: broader single-word topic if the first search came up empty ----------
async function extractBroaderKeyword(question) {
  const sys = 'Give ONE single general English topic word (e.g. "fasting", "marriage", "prayer", "usury", "inheritance") ' +
    'that best categorizes this Islamic question, regardless of what language the question is in. ' +
    'Respond with ONLY that one word, nothing else.';
  const raw = await callClaude(sys, question, 15);
  return raw.trim().replace(/^["']|["']$/g, '');
}

// ---------- step 2a: search Quran (Al Quran Cloud) ----------
async function searchQuran(keyword) {
  try {
    const encoded = encodeURIComponent(keyword);
    const res = await httpsJson({
      hostname: 'api.alquran.cloud',
      path: `/v1/search/${encoded}/all/en`,
      method: 'GET'
    });
    if (res.code !== 200 || !res.data || !res.data.matches || !res.data.matches.length) return [];
    // take top 2 matches
    return res.data.matches.slice(0, 2).map(m => ({
      surah: m.surah.englishName,
      surahNumber: m.surah.number,
      ayahNumber: m.numberInSurah,
      text: m.text,
      ref: `${m.surah.englishName} ${m.surah.number}:${m.numberInSurah}`
    }));
  } catch (e) {
    return [];
  }
}

// fetch Arabic + Indonesian text for a specific ayah reference (used once we know which ayah matched)
async function fetchAyahEditions(surahNumber, ayahNumber, lang) {
  try {
    const editions = lang === 'id' ? 'quran-uthmani,id.indonesian' : 'quran-uthmani,en.sahih';
    const res = await httpsJson({
      hostname: 'api.alquran.cloud',
      path: `/v1/ayah/${surahNumber}:${ayahNumber}/editions/${editions}`,
      method: 'GET'
    });
    if (res.code !== 200 || !res.data) return null;
    const arabic = res.data.find(d => d.edition.identifier === 'quran-uthmani');
    const translation = res.data.find(d => d.edition.identifier !== 'quran-uthmani');
    return {
      arabic: arabic ? arabic.text : '',
      translation: translation ? translation.text : ''
    };
  } catch (e) {
    return null;
  }
}

// ---------- step 2b: search Hadith (HadithAPI.com) ----------
async function searchHadith(keyword) {
  if (!process.env.HADITH_API_KEY) return [];
  try {
    const encoded = encodeURIComponent(keyword);
    const res = await httpsJson({
      hostname: 'hadithapi.com',
      path: `/api/hadiths/?apiKey=${process.env.HADITH_API_KEY}&hadithEnglish=${encoded}&paginate=3`,
      method: 'GET'
    });
    const hadiths = res?.hadiths?.data || [];
    return hadiths.slice(0, 3).map(h => ({
      text: h.hadithEnglish,
      book: h.book?.bookName || '',
      chapter: h.chapter?.chapterEnglish || '',
      number: h.hadithNumber,
      status: h.status || '',
      ref: `${h.book?.bookName || 'Hadith'} #${h.hadithNumber}${h.status ? ' (' + h.status + ')' : ''}`
    }));
  } catch (e) {
    return [];
  }
}

// ---------- step 3: compose the final grounded answer ----------
async function composeAnswer(question, lang, quranResults, hadithResults) {
  const langInstruction = lang === 'id'
    ? 'Jawab dalam Bahasa Indonesia yang baik dan mudah dipahami.'
    : 'Answer in clear, simple English.';

  const quranBlock = quranResults.length
    ? quranResults.map(q => `- ${q.ref}: "${q.text}"${q.arabic ? `\n  Arabic: ${q.arabic}` : ''}`).join('\n')
    : 'No matching Quran verses were retrieved.';

  const hadithBlock = hadithResults.length
    ? hadithResults.map(h => `- ${h.ref}: "${h.text}"`).join('\n')
    : 'No matching Hadith were retrieved.';

  const sys = `You are an Islamic Q&A assistant. You MUST answer using ONLY the retrieved source text provided below. ` +
    `Do NOT add any Quran verse, Hadith, or scholarly claim that is not in the retrieved text. ` +
    `If the retrieved text does not clearly answer the question, say so honestly rather than filling the gap from your own knowledge. ` +
    `For any question of fiqh (rulings) that differs between the four Madhabs (Hanafi, Maliki, Shafi'i, Hanbali), note that scholars differ and advise consulting a qualified local scholar rather than stating a single ruling as definitive. ` +
    langInstruction +
    ` Respond ONLY with a JSON object (no markdown, no code fences): ` +
    `{"answer":"2-4 sentence answer grounded only in the retrieved text below","quran_arabic":"Arabic text of the most relevant retrieved verse, or empty string if none","quran":"the retrieved Quran reference and translation used, or empty string if none","hadith":"the retrieved Hadith reference and text used, or empty string if none","scholars":"brief neutral note if this touches madhab differences, or empty string","refs":["short ref strings actually used"]}`;

  const userText = `Question: ${question}\n\n` +
    `RETRIEVED QURAN VERSES:\n${quranBlock}\n\n` +
    `RETRIEVED HADITH:\n${hadithBlock}\n\n` +
    `Compose the answer using only the above retrieved sources.`;

  const raw = await callClaude(sys, userText, 900);
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

exports.handler = async function (event, context) {
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
    const lang = body.lang === 'id' ? 'id' : 'en';

    if (!question) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing question' }) };
    }

    // 1. Extract search keyword
    const keyword = await extractKeyword(question);

    // 2. Retrieve in parallel
    let [quranMatches, hadithResults] = await Promise.all([
      searchQuran(keyword),
      searchHadith(keyword)
    ]);

    // 2b. Fallback: if both came back empty, retry once with a broader single-word topic
    if (!quranMatches.length && !hadithResults.length) {
      const broaderKeyword = await extractBroaderKeyword(question);
      if (broaderKeyword && broaderKeyword.toLowerCase() !== keyword.toLowerCase()) {
        [quranMatches, hadithResults] = await Promise.all([
          searchQuran(broaderKeyword),
          searchHadith(broaderKeyword)
        ]);
      }
    }

    // 2c. For the top Quran match, fetch Arabic + target-language translation together
    let quranResults = [];
    if (quranMatches.length) {
      const top = quranMatches[0];
      const editions = await fetchAyahEditions(top.surahNumber, top.ayahNumber, lang);
      quranResults = [{
        ref: top.ref,
        text: editions ? editions.translation : top.text,
        arabic: editions ? editions.arabic : ''
      }];
    }

    // 3. Compose grounded answer
    const parsed = await composeAnswer(question, lang, quranResults, hadithResults);

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Analysis failed' }) };
  }
};
