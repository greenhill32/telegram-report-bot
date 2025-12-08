const OpenAI = require('openai');
const axios = require('axios');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Helper: Send message to Telegram
async function sendMessage(chatId, text, options = {}) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    ...options
  });
}

// Helper: Download voice file from Telegram
async function downloadVoiceFile(fileId) {
  const fileResponse = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = fileResponse.data.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  
  const audioResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return Buffer.from(audioResponse.data);
}

// MAIN HANDLER
module.exports = async (req, res) => {

  // GET — for health check
  if (req.method === "GET") {
    return res.status(200).json({ status: "Bot is running!" });
  }

  // POST — Telegram message
  if (req.method === "POST") {
    try {
      const update = req.body;

      // /start
      if (update.message?.text === "/start") {
        await sendMessage(
          update.message.chat.id,
          `👋 Welcome to Report Bot!

*How to use:*
1. Send a voice note
2. Speak like: "Harry Thompson. English 5, Maths 6. Any notes."
3. For multiple students, say: **"Next student"**

Example:
"Harry Thompson. English 5, Maths 6. Improving well. NEXT STUDENT. Sarah Jones. English 8, Maths 9. Excellent progress."`,
          { parse_mode: "Markdown" }
        );
        return res.status(200).json({ ok: true });
      }

      // /help
      if (update.message?.text === "/help") {
        await sendMessage(
          update.message.chat.id,
          `*Voice Note Format:*

"[Name]. [Subject] [score], [Subject] [score]. [Notes]."

For multiple students:
"Harry 5,6 notes. NEXT STUDENT. Sarah 8,9 notes."`,
          { parse_mode: "Markdown" }
        );
        return res.status(200).json({ ok: true });
      }

      // If text (not command)
      if (update.message?.text && !update.message.text.startsWith("/")) {
        await sendMessage(
          update.message.chat.id,
          "Please send a voice note instead of text."
        );
        return res.status(200).json({ ok: true });
      }

      // --- HANDLE VOICE MESSAGE ---
      if (update.message?.voice) {
        const chatId = update.message.chat.id;
        const fileId = update.message.voice.file_id;

        await sendMessage(chatId, "🎤 Processing your voice note...");

        // Download audio
        const audioBuffer = await downloadVoiceFile(fileId);
        const audioFile = new File([audioBuffer], "voice.ogg", { type: "audio/ogg" });

        // Whisper transcription
        const transcription = await openai.audio.transcriptions.create({
          file: audioFile,
          model: "whisper-1",
          language: "en"
        });

        const transcript = transcription.text;
        console.log("Transcript:", transcript);

        // --- MULTI-STUDENT SPLIT ---
        const segments = transcript
          .toLowerCase()
          .split("next student")
          .map(s => s.trim())
          .filter(s => s.length > 0);

        console.log("Detected student segments:", segments.length);

        await sendMessage(chatId, `🤖 Found ${segments.length} student(s). Generating reports...`);

        // --- MAIN LOOP: PROCESS EACH STUDENT ---
        for (let i = 0; i < segments.length; i++) {
          const studentText = segments[i];

          await sendMessage(chatId, `📝 Processing student ${i + 1} of ${segments.length}...`);

          // STEP 1 — Parse JSON for each student
          const parseResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "user",
                content: `Parse this teacher's voice note into JSON.

Voice: "${studentText}"

Return ONLY valid JSON:
{
  "student_name": "Full Name",
  "scores": {
    "English": 5,
    "Maths": 5,
    "Science": 7,
    "PE": 3
  },
  "teacher_notes": "short notes"
}`
              }
            ],
            temperature: 0
          });

          let parsedData;
          try {
            const content = parseResponse.choices[0].message.content;
            const jsonStr = content.replace(/```json\n?|\n?```/g, "").trim();
            parsedData = JSON.parse(jsonStr);
          } catch (err) {
            await sendMessage(chatId, `❌ Could not parse student ${i + 1}.`);
            continue;
          }

          // STEP 2 — Generate report text
          const reportResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "user",
                content: `Write a 120-150 word British end-of-term report.

Student: ${parsedData.student_name}
Scores:
${Object.entries(parsedData.scores)
  .map(([subject, score]) => `- ${subject}: ${score}`)
  .join("\n")}

Teacher notes: "${parsedData.teacher_notes}"

Tone: Warm, professional, specific, encouraging.`
              }
            ],
            temperature: 0.7
          });

          const report = reportResponse.choices[0].message.content;

          // STEP 3 — SEND FINAL REPORT
          await sendMessage(
            chatId,
            `📄 *Report for ${parsedData.student_name}*\n\n${report}`,
            { parse_mode: "Markdown" }
          );

          // STEP 4 — SCORE SUMMARY
          const scoresText = Object.entries(parsedData.scores)
            .filter(([_, score]) => score !== null)
            .map(([subject, score]) => `${subject}: ${score}/10`)
            .join(" | ");

          await sendMessage(chatId, `📊 Scores: ${scoresText}`);
        }

        return res.status(200).json({ ok: true });
      }

      // Unknown message type
      return res.status(200).json({ ok: true });

    } catch (err) {
      console.error("Error:", err);
      if (req.body.message?.chat?.id) {
        await sendMessage(req.body.message.chat.id, `❌ Error: ${err.message}`);
      }
      return res.status(200).json({ ok: false });
    }
  }

  // Unsupported method
  return res.status(405).json({ error: "Method not allowed" });
};
