// Cloudflare Worker entry point — place at repo root as: worker.js
// Handles POST /api/ask, and serves all other requests as static files (index.html, hub.html, etc.)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// ---------- call Claude ----------
async function callClaude(env, system, userText, maxTokens, model = 'claude-sonnet-4-6') {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model,
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
    'CRITICAL: if the question describes a specific historical/religious EVENT indirectly rather than naming it (e.g. "how the 5 daily prayers were commanded" or "sejarah turunnya perintah sholat" refers to the Isra and Mi\'raj / Night Journey), identify the actual event and use the MOST DISTINCTIVE PROPER NOUN from that event\'s narrative as the keyword — one that would survive translation verbatim — rather than a technical/generalized term that translators might phrase differently. Examples: for Isra and Mi\'raj (the 5 daily prayers being commanded), use "Buraq" (the named creature in the narrative) rather than "Miraj" or "prayer command"; for the migration to Madinah, use "Hijrah"; for early battles, use the specific place name like "Badr" or "Uhud". ' +
    'CRITICAL: for "how many / how often / what time" style questions, extract the SPECIFIC RITUAL OR PRACTICE being asked about (e.g. "prayer" or "salah" for prayer count questions, "fasting" for fasting questions) — NEVER use generic words like "time", "times", "day", "count", or "number" as the keyword, since these are common words that will match completely unrelated text in a substring search. ' +
    'Respond with ONLY the keyword phrase, nothing else, no punctuation, no explanation.';
  const raw = await callClaude(env, sys, question, 30, 'claude-haiku-4-5-20251001');
  return raw.trim().replace(/^["']|["']$/g, '');
}

async function extractBroaderKeyword(env, question) {
  const sys = 'Give ONE single English search word that best categorizes this Islamic question, regardless of what language the question is in. ' +
    'IMPORTANT: if the question is about a MODERN topic with no direct textual coverage in classical Quran/Hadith (e.g. cryptocurrency, stock trading, insurance, subscription services, social media, loans, investment apps), ' +
    'do NOT pick a vague or unrelated word — instead pick the closest classical Islamic finance/legal concept AS IT WOULD APPEAR IN AN ENGLISH TRANSLATION of Hadith text (not an Arabic transliteration). Examples: ' +
    'cryptocurrency/stock trading/speculation -> "gambling" or "uncertainty"; interest-based loans/credit cards -> "usury" or "interest"; insurance -> "uncertainty"; gambling apps/lotteries -> "gambling"; general business deals -> "trade". ' +
    'For questions already about classical topics (fasting, marriage, prayer, etc.), just give that topic word directly in plain English. ' +
    'Respond with ONLY that one word, nothing else.';
  const raw = await callClaude(env, sys, question, 15, 'claude-haiku-4-5-20251001');
  return raw.trim().replace(/^["']|["']$/g, '');
}

async function filterRelevant(env, question, quranMatches, hadithResults) {
  if (!quranMatches.length && !hadithResults.length) return { quranMatches, hadithResults };

  const items = [];
  quranMatches.forEach((m, i) => items.push(`Q${i}: ${m.ref} — "${m.text}"`));
  hadithResults.forEach((h, i) => items.push(`H${i}: ${h.ref} — "${h.text}"`));

  const sys = 'You will see a question and a numbered list of candidate Quran verses (Q#) and Hadith (H#) found by a keyword search. ' +
    'Some may only share a common word with the question but are NOT actually on-topic (e.g. a hadith about choosing when to give a sermon is NOT relevant to a question about how many times Muslims pray, even if both mention "time"). ' +
    'Decide which items are GENUINELY relevant and would help answer the question. ' +
    'Respond with ONLY a comma-separated list of the relevant item labels (e.g. "Q0,H1,H2"), or the word "none" if nothing is genuinely relevant. No explanation.';
  const userText = `Question: ${question}\n\nCandidates:\n${items.join('\n')}`;

  try {
    const raw = await callClaude(env, sys, userText, 60, 'claude-haiku-4-5-20251001');
    const kept = raw.trim().toLowerCase();
    if (kept === 'none' || !kept) return { quranMatches: [], hadithResults: [] };

    const keptLabels = kept.split(',').map(s => s.trim().toUpperCase());
    return {
      quranMatches: quranMatches.filter((_, i) => keptLabels.includes(`Q${i}`)).slice(0, 3),
      hadithResults: hadithResults.filter((_, i) => keptLabels.includes(`H${i}`)).slice(0, 5)
    };
  } catch (e) {
    // if the relevance check itself fails, don't block the whole flow — keep original candidates
    return { quranMatches, hadithResults };
  }
}

// surahs that are substantially or entirely a narrative about one figure —
// for these, a "tell me the story of X" question should pull directly from the chapter
// rather than relying on a generic keyword search that only finds passing mentions
const STORY_SURAHS = {
  'yusuf': { number: 12, count: 8 },   // entirely Yusuf's story
  'nuh': { number: 71, count: 8 },     // entirely Nuh's story
  'maryam': { number: 19, count: 8 },  // Maryam & Isa's birth narrative
  'luqman': { number: 31, count: 6 }   // Luqman's counsel to his son
};

function detectStorySurah(question) {
  const q = question.toLowerCase();
  const storyWords = ['cerita', 'kisah', 'story', 'tell me about', 'ceritakan'];
  if (!storyWords.some(w => q.includes(w))) return null;
  for (const [name, info] of Object.entries(STORY_SURAHS)) {
    if (q.includes(name)) return { name, ...info };
  }
  return null;
}

async function fetchSurahOpening(surahNumber, lang, count) {
  try {
    const arabicEdition = 'quran-uthmani';
    const translationEdition = lang === 'id' ? 'id.indonesian' : 'en.sahih';
    const [arRes, trRes] = await Promise.all([
      fetch(`https://api.alquran.cloud/v1/surah/${surahNumber}/${arabicEdition}`),
      fetch(`https://api.alquran.cloud/v1/surah/${surahNumber}/${translationEdition}`)
    ]);
    const [arData, trData] = await Promise.all([arRes.json(), trRes.json()]);
    if (arData.code !== 200 || trData.code !== 200 || !trData.data?.ayahs) return [];
    const surahName = trData.data.englishName;
    return trData.data.ayahs.slice(0, count).map((a, i) => ({
      ref: `${surahName} ${surahNumber}:${a.numberInSurah}`,
      text: a.text,
      arabic: arData.data.ayahs[i]?.text || '',
      surahNumber,
      ayahNumber: a.numberInSurah
    }));
  } catch (e) {
    return [];
  }
}

async function searchQuran(keyword) {
  try {
    const encoded = encodeURIComponent(keyword);
    const res = await fetch(`https://api.alquran.cloud/v1/search/${encoded}/all/en`);
    const data = await res.json();
    if (data.code !== 200 || !data.data || !data.data.matches || !data.data.matches.length) return [];
    return data.data.matches.slice(0, 6).map(m => ({
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
    const res = await fetch(`https://hadithapi.com/api/hadiths/?apiKey=${env.HADITH_API_KEY}&hadithEnglish=${encoded}&paginate=20`);
    const data = await res.json();
    const hadiths = data?.hadiths?.data || [];
    return hadiths.slice(0, 20).map(h => ({
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
    `CONTENT POLICY — sensitive fiqh topics: many users (including teenagers) use this app because they're too shy to ask a sheikh in person about legitimate but personal topics — ghusl, menstruation and purity rulings, marital intimacy, and similar. When retrieved sources cover these, answer factually and respectfully, in the same plain educational register a health class or Islamic studies textbook would use — informative and complete, but never graphic or gratuitously detailed. Use the same measured, clinical terms the Quran/Hadith/fiqh sources themselves use. Do not refuse or deflect a sincere question on these topics just because it feels awkward — that shyness is exactly why this app exists. ` +
    `CONTENT POLICY — off-topic questions: if the question has nothing to do with Islam at all (e.g. random trivia, homework help, jokes, or clearly trying to bait an unrelated/inappropriate response), first check honestly whether the retrieved Quran/Hadith below actually address any real Islamic angle of it. If genuinely none exists, politely note in the "answer" field that this app answers questions about Islam grounded in Quran and Hadith, and invite the user to ask something in that space — keep it brief and friendly, not preachy. ` +
    `CHILD SAFETY: since some users may be minors, never produce sexual, graphic, or romantic content under any framing, even if a question is phrased to try to elicit that — for topics like marital intimacy, stay at the level of what is actually stated in the retrieved fiqh source (rulings, permissibility, etiquette) without descriptive detail. ` +
    `IMPORTANT: the "quran" field must be an ARRAY, one entry per verse listed under RETRIEVED QURAN VERSES below — do not pick just one if multiple were retrieved and are relevant. Each entry must be an object: {"ref":"the verse reference","arabic":"the Arabic text of that verse","text":"the translation"}. If none are relevant, use an empty array. ` +
    `IMPORTANT: the "hadith" field must be an ARRAY OF PLAIN STRINGS (not objects) containing EVERY hadith listed under RETRIEVED HADITH below — one string per hadith, translated into the target language. Each string should read like "Reference: hadith text" combined together as ONE string — do NOT use {"ref":...,"text":...} object format. Do NOT merge multiple hadith into one entry, do NOT summarize them together, and do NOT omit any of them — if 4 hadith were retrieved, return 4 array entries. ` +
    `CRITICAL JSON SAFETY: this response will be parsed as JSON. When quoting speech (e.g. what the Prophet or a narrator said), ALWAYS use single quotes ' around the quoted words, never double quotes " — double quotes inside a field's text will break the JSON structure. Keep every field value on a single line with no literal line breaks inside it (use a space instead of a line break). ` +
    langInstruction +
    ` Respond ONLY with a JSON object (no markdown, no code fences): ` +
    `{"answer":"2-4 sentence answer grounded only in the retrieved text below — if only partially related, say so and note this is the closest match available","quran":[{"ref":"verse reference","arabic":"Arabic text","text":"translation"}],"hadith":["one array entry per retrieved hadith below, each with its reference and full translated text — include ALL of them, or empty array if none"],"tafsir":"summary of Ibn Kathir's commentary if retrieved and relevant, explicitly attributed to him, or empty string if none retrieved","scholars":"brief neutral note if this touches madhab differences, or empty string","refs":["short ref strings actually used"]}`;

  const userText = `Question: ${question}\n\n` +
    `RETRIEVED QURAN VERSES:\n${quranBlock}\n\n` +
    `RETRIEVED HADITH:\n${hadithBlock}\n\n` +
    `RETRIEVED TAFSIR (Ibn Kathir):\n${tafsirBlock}\n\n` +
    `Compose the answer using only the above retrieved sources.`;

  const raw = await callClaude(env, sys, userText, 4000);

  function tryParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // stage 1: straightforward parse after stripping code fences
  const stripped = raw.replace(/```json|```/g, '').trim();
  let result = tryParse(stripped);

  // stage 2: extract just the { ... } block in case Claude added any stray text around it
  if (!result) {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      result = tryParse(stripped.slice(start, end + 1));
    }
  }

  // stage 3: repair common formatting slips — literal line breaks/tabs inside strings, trailing commas
  if (!result) {
    let repaired = stripped;
    const start = repaired.indexOf('{');
    const end = repaired.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) repaired = repaired.slice(start, end + 1);
    repaired = repaired.replace(/\r?\n/g, ' ').replace(/\t/g, ' ');
    repaired = repaired.replace(/,(\s*[}\]])/g, '$1'); // remove trailing commas before } or ]
    result = tryParse(repaired);
  }

  if (result) return result;

  // give up gracefully — fall back to a plain response built directly from the raw retrieved sources
  const untranslatedNote = lang === 'id' ? ' [teks asli Inggris]' : '';
  const fallbackNote = lang === 'id'
    ? 'Terjadi kendala teknis saat menyusun jawaban. Berikut sumber yang berhasil ditemukan:'
    : 'There was a technical issue composing the answer. Here are the sources that were found:';
  return {
    answer: fallbackNote,
    quran: quranResults.map(q => ({ ref: q.ref, arabic: q.arabic || '', text: q.text })),
    hadith: hadithResults.map(h => `${h.ref}: ${h.text}${untranslatedNote}`),
    tafsir: '',
    scholars: '',
    refs: [...quranResults.map(q => q.ref), ...hadithResults.map(h => h.ref)]
  };
}

function quranItemToObject(item, fallbackLang) {
  if (item && typeof item === 'object' && (item.text || item.ref)) {
    return { ref: item.ref || '', arabic: item.arabic || item.quran_arabic || '', text: item.text || '' };
  }
  if (typeof item === 'string') {
    return { ref: '', arabic: '', text: item };
  }
  return null;
}

function hadithItemToString(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const ref = item.ref || item.reference || item.book || '';
    const text = item.text || item.content || item.hadith || item.translation || '';
    if (ref || text) return [ref, text].filter(Boolean).join(': ');
    try { return JSON.stringify(item); } catch (e) { return String(item); }
  }
  return String(item);
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
    const storySurah = detectStorySurah(question);

    let quranMatches, hadithResults;
    let storyVerses = [];

    if (storySurah) {
      // dedicated-chapter path: pull directly from the relevant surah instead of generic keyword search
      const [verses, hadithSearch] = await Promise.all([
        fetchSurahOpening(storySurah.number, lang, storySurah.count),
        searchHadith(env, keyword)
      ]);
      storyVerses = verses;
      quranMatches = []; // handled separately via storyVerses below
      hadithResults = hadithSearch;
    } else {
      [quranMatches, hadithResults] = await Promise.all([
        searchQuran(keyword),
        searchHadith(env, keyword)
      ]);
    }

    // fallback 1: if the multi-word phrase found nothing, try just its first word —
    // single terms often match substring search better than phrases (e.g. "Dajjal" alone vs "Dajjal appearance signs")
    if (!storySurah && !quranMatches.length && !hadithResults.length) {
      const firstWord = keyword.split(/\s+/)[0];
      if (firstWord && firstWord.toLowerCase() !== keyword.toLowerCase()) {
        [quranMatches, hadithResults] = await Promise.all([
          searchQuran(firstWord),
          searchHadith(env, firstWord)
        ]);
      }
    }

    // fallback 2: broader general topic category as a last resort
    if (!storySurah && !quranMatches.length && !hadithResults.length) {
      const broaderKeyword = await extractBroaderKeyword(env, question);
      if (broaderKeyword && broaderKeyword.toLowerCase() !== keyword.toLowerCase()) {
        [quranMatches, hadithResults] = await Promise.all([
          searchQuran(broaderKeyword),
          searchHadith(env, broaderKeyword)
        ]);
      }
    }

    // filter out false-positive substring matches (e.g. a hadith that only shares a common word
    // with the question but isn't actually on-topic) before using them in the final answer —
    // skip this for the Quran side in story mode, since those verses are already curated by chapter
    if (storySurah) {
      const filtered = await filterRelevant(env, question, [], hadithResults);
      hadithResults = filtered.hadithResults;
    } else {
      ({ quranMatches, hadithResults } = await filterRelevant(env, question, quranMatches, hadithResults));
    }

    let quranResults = [];
    let tafsirText = '';
    if (storySurah && storyVerses.length) {
      quranResults = storyVerses;
      tafsirText = await fetchIbnKathirTafsir(storyVerses[0].surahNumber, storyVerses[0].ayahNumber);
    } else if (quranMatches.length) {
      // fetch full details (Arabic + translation) for every relevant match found, not just the first —
      // general questions deserve the same thoroughness as story questions
      quranResults = await Promise.all(quranMatches.map(async (m) => {
        const [arabicText, translationText] = await Promise.all([
          fetchArabicAyah(m.surahNumber, m.ayahNumber),
          fetchTranslationAyah(m.surahNumber, m.ayahNumber, lang)
        ]);
        return {
          ref: m.ref,
          text: translationText !== null ? translationText : (lang === 'id'
            ? '[Terjemahan Bahasa Indonesia untuk ayat ini tidak berhasil dimuat — hanya teks Arab yang tersedia]'
            : m.text),
          arabic: arabicText,
          surahNumber: m.surahNumber,
          ayahNumber: m.ayahNumber
        };
      }));
      // tafsir only for the top match, to keep the prompt a reasonable size
      tafsirText = await fetchIbnKathirTafsir(quranMatches[0].surahNumber, quranMatches[0].ayahNumber);
    }

    const parsed = await composeAnswer(env, question, lang, quranResults, hadithResults, tafsirText);

    // safety net: if hadith were genuinely retrieved (and already passed the relevance filter above)
    // but Claude's JSON came back without them, that's likely a formatting slip worth rescuing.
    // BUT if Claude's own answer text indicates it deliberately judged the sources as not relevant,
    // trust that judgment instead of overriding it with raw data.
    const notRelevantSignals = [
      'tidak relevan', 'tidak membahas', 'tidak ditemukan', 'bukan jawaban langsung',
      'not relevant', 'does not address', 'not found', 'not directly relevant', "doesn't address"
    ];
    const answerLower = (parsed.answer || '').toLowerCase();
    const claudeSignaledNotRelevant = notRelevantSignals.some(s => answerLower.includes(s));

    const hadithFromModelRaw = Array.isArray(parsed.hadith) ? parsed.hadith : (parsed.hadith ? [parsed.hadith] : []);
    const hadithFromModel = hadithFromModelRaw.map(hadithItemToString);
    if (!hadithFromModel.length && hadithResults.length && !claudeSignaledNotRelevant) {
      const note = lang === 'id' ? ' [teks asli Inggris, terjemahan gagal dimuat]' : '';
      parsed.hadith = hadithResults.map(h => `${h.ref}: ${h.text}${note}`);
    } else {
      parsed.hadith = hadithFromModel;
    }

    // same safety net for quran: normalize whatever shape came back, and rescue if genuinely relevant
    // verses were retrieved but Claude's array came back empty (without overriding a deliberate judgment)
    const quranFromModelRaw = Array.isArray(parsed.quran) ? parsed.quran : (parsed.quran ? [parsed.quran] : []);
    const quranFromModel = quranFromModelRaw.map(q => quranItemToObject(q)).filter(Boolean);
    if (!quranFromModel.length && quranResults.length && !claudeSignaledNotRelevant) {
      parsed.quran = quranResults.map(q => ({ ref: q.ref, arabic: q.arabic || '', text: q.text }));
    } else {
      parsed.quran = quranFromModel;
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
