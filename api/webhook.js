const OpenAI = require('openai');
const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ────── MARKDOWNV2 ESCAPE HELPER ──────
function escapeMarkdownV2(text) {
  if (!text) return '';
  return text.replace(/([_*[\]()~`>#+=|{}.!-])/g, '\\$1');
}

// ────── SEND MESSAGE ──────
async function sendMessage(chatId, text, options = {}) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
      ...options
    });
  } catch (err) {
    console.error("Telegram send error:", err.response?.data || err.message);
  }
}

// ────── DOWNLOAD VOICE FILE ──────
async function downloadVoiceFile(fileId) {
  const fileResponse = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = fileResponse.data.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

  const audioResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return Buffer.from(audioResponse.data);
}

// ────── MAIN WEBHOOK HANDLER ──────
module.exports = async (req, res) => {
  if (req.method === "GET") {
    return res.status(200).json({ status: "Report Bot is alive!", time: new Date().toISOString() });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const update = req.body;

    // Debug incoming updates
    console.log("INCOMING UPDATE:", JSON.stringify(update, null, 2));

    // ────── /start command ──────
    if (update.message?.text?.startsWith("/start")) {
      const welcome = escapeMarkdownV2(
`*Welcome to Report Bot!*

*How to use:*
1\\. Send a voice note
2\\. Speak clearly: "Harry Thompson\\. English 5, Maths 6\\. Well done\\."
3\\. For multiple students, say: "NEXT STUDENT"

*Example:*
"Harry Thompson\\. English 7, Maths 8\\. Great effort\\. NEXT STUDENT\\. Sarah Jones\\. English 9, Science 10\\. Outstanding\\."

Just record and send — I’ll write perfect British reports!`
      );

      await sendMessage(update.message.chat.id, welcome);
      return res.status(200).json({ ok: true });
    }

    // ────── /help command ──────
    if (update.message?.text?.startsWith("/help")) {
      const help = escapeMarkdownV2(
`*Voice Format Tips:*

• Say the name first
• Then subjects and scores: "English 8, Maths 7"
• Add a note: "Needs to focus more"
• For next child: say "NEXT STUDENT"

Works even with messy speech — I’ll clean it up\\!`
      );

      await sendMessage(update.message.chat.id, help);
      return res.status(200).json({ ok: true });
    }

    // ────── Reject plain text (must be voice) ──────
    if (update.message?.text && !update.message.text.startsWith("/")) {
      await sendMessage(update.message.chat.id,
        escapeMarkdownV2("Please send a *voice note* — text reports are not supported\\."));
      return res.status(200).json({ ok: true });
    }

    // ────── PROCESS VOICE MESSAGES ──────
    if (update.message?.voice) {
      const chatId = update.message.chat.id;
      const fileId = update.message.voice.file_id;

      await sendMessage(chatId, "Processing your voice note...");

      const audioBuffer = await downloadVoiceFile(fileId);
      const audioFile = new File([audioBuffer], "voice.ogg", { type: "audio/ogg" });

      // ── Whisper transcription
      const transcription = await openai.audio.transcriptions.create({
        file: audioFile,
        model: "whisper-1",
        language: "en"
      });

      const transcript = transcription.text.trim();
      console.log("Transcript:", transcript);

      if (!transcript) {
        await sendMessage(chatId, "I couldn't hear anything\\. Please try again\\.");
        return res.status(200).json({ ok: true });
      }

      // Split on "next student"
      const segments = transcript
        .toLowerCase()
        .split(/\bnext student\b/)
        .map(x => x.trim())
        .filter(x => x.length > 0);

      await sendMessage(chatId, `Found ${segments.length} student(s)\\. Generating reports...`);

      // ────── Process each student ──────
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];

        await sendMessage(chatId, `Processing student ${i + 1} of ${segments.length}...`);

        // Step 1: JSON parsing via GPT
        const parseResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [{
            role: "user",
            content: `Extract student data from this spoken text into valid JSON only.

Text: "${segment}"

Return ONLY this JSON:
{
  "student_name": "Full Name",
  "scores": {"English": 5, "Maths": 6, "Science": null},
  "teacher_notes": "short comment or empty string"
}`
          }]
        });

        let parsedData;
        try {
          const raw = parseResponse.choices[0].message.content;
          const jsonStr = raw.replace(/```json|```/g, "").trim();
          parsedData = JSON.parse(jsonStr);
        } catch (err) {
          console.error("JSON parse fail:", err);
          await sendMessage(chatId, `Could not understand student ${i + 1} — skipping\\.`);
          continue;
        }

        // Step 2: Generate written report
        const reportResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.6,
          messages: [{
            role: "user",
            content: `Write a warm British end-of-term report (50–80 words).

Student: ${parsedData.student_name}
Scores: ${Object.entries(parsedData.scores)
              .filter(([_, v]) => v !== null)
              .map(([s, v]) => `${s}: ${v}/10`)
              .join(", ") || "Not provided"}

Notes: "${parsedData.teacher_notes}"

Tone: encouraging, specific, positive.`
          }]
        });

        const reportText = reportResponse.choices[0].message.content.trim();

        // Step 3: Send formatted report
        const header = escapeMarkdownV2(`*Report for ${parsedData.student_name}*`);
        const body = escapeMarkdownV2(reportText);

        await sendMessage(chatId, `${header}\n\n${body}`);

        // Step 4: Send scores summary
        const scoresList = Object.entries(parsedData.scores)
          .filter(([_, v]) => v !== null)
          .map(([s, v]) => `${s}: ${v}/10`)
          .join(" \\| ");

        if (scoresList) {
          await sendMessage(chatId, escapeMarkdownV2(`*Scores:* ${scoresList}`));
        }

        // separator
        if (i < segments.length - 1) {
          await sendMessage(chatId, "────────────────────");
        }
      }

      await sendMessage(chatId, "All reports completed!");
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("Fatal Error:", err);

    if (req.body?.message?.chat?.id) {
      await sendMessage(req.body.message.chat.id,
        "Sorry, something went wrong\\. Please try again\\.");
    }

    return res.status(200).json({ ok: false, error: err.message });
  }
};
