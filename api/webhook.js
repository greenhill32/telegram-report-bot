const OpenAI = require('openai');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const createReport = require('docx-templates').default;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function sendMessage(chatId, text, options = {}) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, ...options });
}

async function downloadVoiceFile(fileId) {
  const fileResponse = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = fileResponse.data.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const audioResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  return Buffer.from(audioResponse.data);
}

module.exports = async (req, res) => {
  if (req.method === "GET") return res.status(200).json({ status: "Bot is running!" });

  try {
    const update = req.body;

    if (update.message?.text === "/start" || update.message?.text === "/help") {
      await sendMessage(update.message.chat.id, `📚 Dorset House Report Bot

Send a voice note:
"Harry Ramsden. English 7, Maths 5, PE 9. Great attitude, needs punctuation work.

NEXT STUDENT

Lisa Simpson. English 9, Maths 9, PE 2. Excellent work, hates rugby."

You'll get editable Word documents with your letterhead.`);
      return res.status(200).send("ok");
    }

    if (!update.message?.voice) {
      await sendMessage(update.message.chat.id, "Please send a voice note.");
      return res.status(200).send("ok");
    }

    const chatId = update.message.chat.id;
    const fileId = update.message.voice.file_id;

    await sendMessage(chatId, "🎙️ Transcribing...");

    const audioBuffer = await downloadVoiceFile(fileId);
    const audioFile = new File([audioBuffer], "voice.ogg", { type: "audio/ogg" });

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      language: "en"
    });

    const segments = transcription.text
      .split(/next student/i)
      .map(s => s.trim())
      .filter(s => s.length > 10);

    if (segments.length === 0) {
      await sendMessage(chatId, "❌ No students found. Say 'NEXT STUDENT' between each.");
      return res.status(200).send("ok");
    }

    await sendMessage(chatId, `✅ Found ${segments.length} student(s). Generating...`);

    for (let i = 0; i < segments.length; i++) {
      const studentText = segments[i];

      // Parse student data
      const parseResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [{ 
          role: "user", 
          content: `Parse teacher's voice note into JSON.

Voice note: "${studentText}"

Return ONLY valid JSON:
{
  "student_name": "Full Name",
  "scores": {"English": 7, "Maths": 5, "PE": 9, "Science": null},
  "teacher_notes": "All descriptive comments"
}`
        }]
      });

      let data;
      try {
        const json = parseResp.choices[0].message.content.replace(/```json|```/g, "").trim();
        data = JSON.parse(json);
      } catch (e) {
        await sendMessage(chatId, `⚠️ Couldn't parse student ${i+1}`);
        continue;
      }

      // Generate subject comments
      const subjectCommentsResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.7,
        messages: [{ 
          role: "user", 
          content: `You're a 25-year-old British teacher. Write SHORT 3-5 word comments for each subject.

Student: ${data.student_name}
Notes: "${data.teacher_notes}"
Scores: ${JSON.stringify(data.scores)}

Return ONLY JSON:
{"English": "Strong creative writing", "Maths": "Needs more practice"}`
        }]
      });

      let subjectComments = {};
      try {
        const json = subjectCommentsResp.choices[0].message.content.replace(/```json|```/g, "").trim();
        subjectComments = JSON.parse(json);
      } catch (e) {
        Object.keys(data.scores).forEach(subject => {
          if (data.scores[subject]) {
            subjectComments[subject] = data.scores[subject] >= 7 ? "Good progress" : "Working hard";
          }
        });
      }

      // Generate full report
      const reportResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.8,
        messages: [{ 
          role: "user", 
          content: `You're a 25-year-old British teacher. Cool but professional. Write 120-150 words for ${data.student_name}. Use correct pronouns based on name.

Scores: ${Object.entries(data.scores).filter(([_,v])=>v).map(([s,v])=>`${s}: ${v}/10`).join(", ")}
Notes: "${data.teacher_notes}"

Natural language ("stepped up", "smashing it"). Be honest, warm, specific. No bullets.`
        }]
      });
      const reportText = reportResp.choices[0].message.content.trim();

      // Prepare data for template
      const subjects = Object.entries(data.scores)
        .filter(([_, score]) => score !== null)
        .map(([name, score]) => ({
          name: name,
          score: score.toString(),
          comments: subjectComments[name] || "Progressing well"
        }));

      // Load template and fill it
      const template = fs.readFileSync('./REPORT_TEMPLATE.docx');
      
      const filled = await createReport({
        template: template,
        data: {
          STUDENT_NAME: data.student_name,
          SUBJECTS: subjects,
          REPORT_TEXT: reportText
        }
      });

      // Save and send
      const safeName = data.student_name.replace(/[^a-zA-Z0-9]/g, "_");
      const filename = `${safeName}_Report.docx`;
      const tmpPath = `/tmp/${filename}`;
      fs.writeFileSync(tmpPath, filled);

      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', fs.createReadStream(tmpPath), { filename });
      form.append('caption', `📄 ${data.student_name}'s Report`);

      await axios.post(`${TELEGRAM_API}/sendDocument`, form, { 
        headers: form.getHeaders() 
      });
      fs.unlinkSync(tmpPath);

      console.log(`✅ ${data.student_name}`);
    }

    await sendMessage(chatId, "✨ All reports sent!");

  } catch (err) {
    console.error("Error:", err);
    if (req.body.message?.chat?.id) {
      await sendMessage(req.body.message.chat.id, `❌ Error: ${err.message}`);
    }
  }

  res.status(200).send("ok");
};
