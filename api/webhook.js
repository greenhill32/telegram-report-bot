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

// Main handler
module.exports = async (req, res) => {
  // Handle GET requests (for verification)
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'Bot is running!' });
  }

  // Handle POST requests from Telegram
  if (req.method === 'POST') {
    try {
      const update = req.body;

      // Handle /start command
      if (update.message?.text === '/start') {
        await sendMessage(
          update.message.chat.id,
          `👋 Welcome to Report Bot!

*How to use:*
1. Send a voice note
2. Say: "Student name. Subject scores (1-10). Any notes."
3. Example: "Harry Thompson. English 5, Maths 3, PE 7. Harry struggles with focus but excels in sport."

I'll generate a professional report within seconds!`,
          { parse_mode: 'Markdown' }
        );
        return res.status(200).json({ ok: true });
      }

      // Handle /help command
      if (update.message?.text === '/help') {
        await sendMessage(
          update.message.chat.id,
          `*Voice Note Format:*

"[Name]. [Subject] [score], [Subject] [score]. [Notes about student]."

*Example:*
"Harry Thompson. English 5, Maths 3, Science 6, PE 7. Harry has shown great improvement in PE and is very enthusiastic. Still struggles with maths concepts."`,
          { parse_mode: 'Markdown' }
        );
        return res.status(200).json({ ok: true });
      }

      // Handle regular text messages
      if (update.message?.text && !update.message.text.startsWith('/')) {
        await sendMessage(
          update.message.chat.id,
          'Please send a voice note instead of text. Tap the microphone icon and speak.'
        );
        return res.status(200).json({ ok: true });
      }

      // Handle voice messages
      if (update.message?.voice) {
        const chatId = update.message.chat.id;
        const fileId = update.message.voice.file_id;

        // Send processing message
        await sendMessage(chatId, '🎤 Processing your voice note...');

        // Download voice file
        const audioBuffer = await downloadVoiceFile(fileId);

        // Create a File object for Whisper
        const audioFile = new File([audioBuffer], 'voice.ogg', { type: 'audio/ogg' });

        // Transcribe with Whisper
        const transcription = await openai.audio.transcriptions.create({
          file: audioFile,
          model: 'whisper-1',
          language: 'en'
        });

        const transcript = transcription.text;
        console.log('Transcript:', transcript);

        // Parse the transcript
        await sendMessage(chatId, '🤖 Generating report...');

        const parseResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{
            role: 'user',
            content: `Parse this teacher's voice note into JSON format. Extract the student name, scores for subjects (1-10 scale), and any additional notes.

Voice note: "${transcript}"

Return ONLY valid JSON with this structure (use null if a score isn't mentioned):
{
  "student_name": "Full Name",
  "scores": {
    "English": 5,
    "Maths": 5,
    "Science": 7,
    "PE": 3
  },
  "teacher_notes": "brief summary of what teacher said"
}`
          }],
          temperature: 0
        });

        // Extract and parse JSON
        let parsedData;
        try {
          const content = parseResponse.choices[0].message.content;
          const jsonStr = content.replace(/```json\n?|\n?```/g, '').trim();
          parsedData = JSON.parse(jsonStr);
        } catch (e) {
          await sendMessage(chatId, '❌ Could not parse the voice note. Please try again with format: "Student name. Subject scores. Notes."');
          return res.status(200).json({ ok: true });
        }

        // Generate the report
        const reportResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{
            role: 'user',
            content: `You are writing an end-of-term report for a British prep school student.

Student: ${parsedData.student_name}
Scores (1-10 scale):
${Object.entries(parsedData.scores).map(([subject, score]) => `- ${subject}: ${score}`).join('\n')}

Teacher's notes: "${parsedData.teacher_notes}"

Write a 80-100 word report in a warm but professional tone. Use British English.
Structure: Opening sentence about overall performance → specific subject strengths → areas for development → encouraging close.
Be specific but kind. Refer to the student by name.`
          }],
          temperature: 0.7
        });

        const report = reportResponse.choices[0].message.content;

        // Send the report back
        await sendMessage(chatId, `📄 *Report for ${parsedData.student_name}*\n\n${report}`, {
          parse_mode: 'Markdown'
        });

        // Send scores summary
        const scoresText = Object.entries(parsedData.scores)
          .filter(([_, score]) => score !== null)
          .map(([subject, score]) => `${subject}: ${score}/10`)
          .join(' | ');
        
        await sendMessage(chatId, `📊 Scores: ${scoresText}`);

        return res.status(200).json({ ok: true });
      }

      // Unknown message type
      return res.status(200).json({ ok: true });

    } catch (error) {
      console.error('Error:', error);
      
      // Try to send error message to user if we have a chat ID
      if (req.body.message?.chat?.id) {
        try {
          await sendMessage(req.body.message.chat.id, `❌ Error: ${error.message}`);
        } catch (e) {
          console.error('Could not send error message:', e);
        }
      }
      
      return res.status(200).json({ ok: false, error: error.message });
    }
  }

  // Method not allowed
  return res.status(405).json({ error: 'Method not allowed' });
};
