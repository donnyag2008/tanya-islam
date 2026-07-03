// Cloudflare Worker entry point — place at repo root as: worker.js
// Handles POST /api/ask, and serves all other requests as static files (index.html, hub.html, etc.)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// ---------- call Claude ----------
async function callClaude(env, system, userText, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: system,
      messages: [{ role: 'user', content: userText }]
    })
  });

  const result = await res.json();
  if (result.error) throw new Error(result.error.message);
  return result.content?.find(b => b.type === 'text')?.text || '';
}

async function extractKeyword(env, question) {
  const sys = 'Extract the single best English search keyword or short phrase (2-4 words max) ' +
    'that would find relevant Quran verses and Hadith about this Islamic question, regardless of what language the question is in. ' +
    'CRITICAL: if the question names a specific Islamic figure, entity, or term (e.g. Dajjal, Yajuj, Isa, Khidr, Barzakh, Qiyamah), you MUST include that exact term verbatim in your answer — do not paraphrase or generalize it away. ' +
    'Respond with ONLY the keyword phrase, nothing else, no punctuation, no explanation.';
  const raw = await callClaude(env, sys, question, 30);
  return raw.trim().replace(/^["']|["']$/g, '');
}

async function extractBroaderKeyword(env, question) {
  const sys = 'Give ONE single general English topic word (e.g. "fasting", "marriage", "prayer", "usury", "inheritance") ' +
    'that best categorizes this Islamic question, regardless of what language the question is in. ' +
    'Respond with ONLY that one word, nothing else.';
  const raw = await callClaude(env, sys, question, 15);
  return raw.trim().replace(/^["']|["']$/g, '');
}

async function searchQuran(keyword) {
  try {
    const encoded = encodeURIComponent(keyword);
    const res = await fetch(`https://api.alquran.cloud/v1/search/${encoded}/all/en`);
    const data = await res.json();
    if (data.code !== 200 || !data.data || !data.data.matches || !data.data.matches.length) return [];
    return data.data.matches.slice(0, 2).map(m => ({
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

async function fetchArabicAyah(surahNumber, ayahNumber) {
  try {
    const res = await fetch(`https://api.alquran.cloud/v1/ayah/${surahNumber}:${ayahNumber}/quran-uthmani`);
    const data = await res.json();
    if (data.code !== 200 || !data.data) return '';
    return data.data.text || '';
  } catch (e) {
    return '';
  }
}

// fetch the target-language translation; try twice before giving up, and NEVER fall back to a different language
async function fetchTranslationAyah(surahNumber, ayahNumber, lang) {
  const edition = lang === 'id' ? 'id.indonesian' : 'en.sahih';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://api.alquran.cloud/v1/ayah/${surahNumber}:${ayahNumber}/${edition}`);
      const data = await res.json();
      if (data.code === 200 && data.data && data.data.text) return data.data.text;
    } catch (e) {
      // try again on next loop iteration
    }
  }
  return null; // signal genuine failure — caller must NOT substitute another language's text
}

async function fetchIbnKathirTafsir(surahNumber, ayahNumber) {
  try {
    const res = await fetch(`https://quranapi.pages.dev/api/tafsir/${surahNumber}_${ayahNumber}.json`);
    const data = await res.json();
    const entry = (data?.tafsirs || []).find(t => t.author === 'Ibn Kathir');
    if (!entry || !entry.content) return '';
    // truncate — tafsir entries can run long; keep it to a reasonable size for the prompt
    return entry.content.replace(/[#*_]/g, '').slice(0, 1200);
  } catch (e) {
    return '';
  }
}

async function searchHadith(env, keyword) {
  if (!env.HADITH_API_KEY) return [];
  try {
    const encoded = encodeURIComponent(keyword);
    const res = await fetch(`https://hadithapi.com/api/hadiths/?apiKey=${env.HADITH_API_KEY}&hadithEnglish=${encoded}&paginate=5`);
    const data = await res.json();
    const hadiths = data?.hadiths?.data || [];
    return hadiths.slice(0, 5).map(h => ({
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

async function composeAnswer(env, question, lang, quranResults, hadithResults, tafsirText) {
  const langInstruction = lang === 'id'
    ? 'Jawab dalam Bahasa Indonesia yang santai tapi tetap sopan dan kredibel — gaya semi-formal yang mudah dipahami anak muda, hindari bahasa yang terlalu kaku atau akademis, tapi tetap hormat saat membahas ayat, hadis, atau pendapat ulama.'
    : 'Answer in clear, friendly, semi-formal English that a young person could easily follow — approachable and conversational, not stiff or overly academic, while staying respectful when discussing verses, hadith, or scholarly opinions.';

  const quranBlock = quranResults.length
    ? quranResults.map(q => `- ${q.ref}: "${q.text}"${q.arabic ? `\n  Arabic: ${q.arabic}` : ''}`).join('\n')
    : 'No matching Quran verses were retrieved.';

  const hadithBlock = hadithResults.length
    ? hadithResults.map(h => `- ${h.ref}: "${h.text}"`).join('\n')
    : 'No matching Hadith were retrieved.';

  const tafsirBlock = tafsirText ? tafsirText : 'No Ibn Kathir tafsir was retrieved for this verse.';

  const sys = `You are an Islamic Q&A assistant. You MUST answer using ONLY the retrieved source text provided below. ` +
    `Do NOT add any Quran verse, Hadith, tafsir commentary, or scholarly claim that is not in the retrieved text. ` +
    `If the retrieved text is only partially related to the question (not a perfect match, but touches the same topic or figure), still USE it — summarize what it does say, and clearly tell the reader this is the closest available match rather than a direct answer, and that they should verify details with a qualified scholar or a trusted, detailed source (e.g. an established tafsir or hadith commentary) for the full picture, especially on topics with many narrations like end-times/eschatology. ` +
    `Only say no relevant information was found if the retrieved text below is truly empty or completely unrelated to the topic. ` +
    `If RETRIEVED TAFSIR (Ibn Kathir) below is non-empty and relevant, summarize his commentary in the "tafsir" field, explicitly attributed to Ibn Kathir — do not invent commentary from any other scholar (e.g. never attribute anything to Buya Hamka or Al-Ghazali, since their commentary is not available in the retrieved sources). ` +
    `For any question of fiqh (rulings) that differs between the four Madhabs (Hanafi, Maliki, Shafi'i, Hanbali), note that scholars differ and advise consulting a qualified local scholar rather than stating a single ruling as definitive. ` +
    `IMPORTANT: the "hadith" field must be an ARRAY containing EVERY hadith listed under RETRIEVED HADITH below — one array entry per hadith, translated into the target language. Do NOT merge multiple hadith into one entry, do NOT summarize them together, and do NOT omit any of them — if 4 hadith were retrieved, return 4 array entries. Each entry should include its reference and its full text. ` +
    langInstruction +
    ` Respond ONLY with a JSON object (no markdown, no code fences): ` +
    `{"answer":"2-4 sentence answer grounded only in the retrieved text below — if only partially related, say so and note this is the closest match available","quran_arabic":"Arabic text of the most relevant retrieved verse, or empty string if none","quran":"the retrieved Quran reference and translation used, or empty string if none","hadith":["one array entry per retrieved hadith below, each with its reference and full translated text — include ALL of them, or empty array if none"],"tafsir":"summary of Ibn Kathir's commentary if retrieved and relevant, explicitly attributed to him, or empty string if none retrieved","scholars":"brief neutral note if this touches madhab differences, or empty string","refs":["short ref strings actually used"]}`;

  const userText = `Question: ${question}\n\n` +
    `RETRIEVED QURAN VERSES:\n${quranBlock}\n\n` +
    `RETRIEVED HADITH:\n${hadithBlock}\n\n` +
    `RETRIEVED TAFSIR (Ibn Kathir):\n${tafsirBlock}\n\n` +
    `Compose the answer using only the above retrieved sources.`;

  const raw = await callClaude(env, sys, userText, 900);
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

async function handleAsk(request, env) {
  try {
    const body = await request.json();
    const question = body.question;
    const lang = body.lang === 'id' ? 'id' : 'en';

    if (!question) {
      return new Response(JSON.stringify({ error: 'Missing question' }), { status: 400, headers: CORS_HEADERS });
    }

    const keyword = await extractKeyword(env, question);

    let [quranMatches, hadithResults] = await Promise.all([
      searchQuran(keyword),
      searchHadith(env, keyword)
    ]);

    // fallback 1: if the multi-word phrase found nothing, try just its first word —
    // single terms often match substring search better than phrases (e.g. "Dajjal" alone vs "Dajjal appearance signs")
    if (!quranMatches.length && !hadithResults.length) {
      const firstWord = keyword.split(/\s+/)[0];
      if (firstWord && firstWord.toLowerCase() !== keyword.toLowerCase()) {
        [quranMatches, hadithResults] = await Promise.all([
          searchQuran(firstWord),
          searchHadith(env, firstWord)
        ]);
      }
    }

    // fallback 2: broader general topic category as a last resort
    if (!quranMatches.length && !hadithResults.length) {
      const broaderKeyword = await extractBroaderKeyword(env, question);
      if (broaderKeyword && broaderKeyword.toLowerCase() !== keyword.toLowerCase()) {
        [quranMatches, hadithResults] = await Promise.all([
          searchQuran(broaderKeyword),
          searchHadith(env, broaderKeyword)
        ]);
      }
    }

    let quranResults = [];
    let tafsirText = '';
    if (quranMatches.length) {
      const top = quranMatches[0];
      const [arabicText, translationText, tafsir] = await Promise.all([
        fetchArabicAyah(top.surahNumber, top.ayahNumber),
        fetchTranslationAyah(top.surahNumber, top.ayahNumber, lang),
        fetchIbnKathirTafsir(top.surahNumber, top.ayahNumber)
      ]);
      quranResults = [{
        ref: top.ref,
        text: translationText !== null ? translationText : (lang === 'id'
          ? '[Terjemahan Bahasa Indonesia untuk ayat ini tidak berhasil dimuat — hanya teks Arab yang tersedia]'
          : top.text),
        arabic: arabicText
      }];
      tafsirText = tafsir;
    }

    const parsed = await composeAnswer(env, question, lang, quranResults, hadithResults, tafsirText);

    // safety net: if hadith were genuinely retrieved but Claude's JSON came back without them
    // (empty array, wrong type, or omitted), show the actual retrieved hadith directly rather
    // than silently losing them — reliability here should not depend on the model's JSON compliance
    const hadithFromModel = Array.isArray(parsed.hadith) ? parsed.hadith : (parsed.hadith ? [parsed.hadith] : []);
    if (!hadithFromModel.length && hadithResults.length) {
      const note = lang === 'id' ? ' [teks asli Inggris, terjemahan gagal dimuat]' : '';
      parsed.hadith = hadithResults.map(h => `${h.ref}: ${h.text}${note}`);
    } else {
      parsed.hadith = hadithFromModel;
    }

    return new Response(JSON.stringify(parsed), { status: 200, headers: CORS_HEADERS });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Analysis failed' }), { status: 500, headers: CORS_HEADERS });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/ask') {
      if (request.method === 'OPTIONS') {
        return new Response('', { status: 200, headers: CORS_HEADERS });
      }
      if (request.method === 'POST') {
        return handleAsk(request, env);
      }
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS_HEADERS });
    }

    // everything else: serve static files (index.html, hub.html, halal.html, etc.)
    return env.ASSETS.fetch(request);
  }
};
