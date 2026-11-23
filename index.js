const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// API Keys සේව් කර තබා ගන්නා ගොනුව
const API_DB_FILE = './user_apis.json';
if (!fs.existsSync(API_DB_FILE)) fs.writeJsonSync(API_DB_FILE, {});

function getUserApi(userNumber) {
    const db = fs.readJsonSync(API_DB_FILE);
    return db[userNumber] || null;
}

function setUserApi(userNumber, apiKey) {
    const db = fs.readJsonSync(API_DB_FILE);
    db[userNumber] = apiKey;
    fs.writeJsonSync(API_DB_FILE, db);
}

// සක්‍රිය බොට් සෙෂන්ස් තබා ගැනීම
const activeSessions = new Map();

async function startBotSession(number, res = null) {
    const sessionDir = `./sessions/${number}`;
    await fs.ensureDir(sessionDir);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['STAR WEB', 'Chrome', '1.0.0']
    });

    // Pairing Code එක ලබා දීම (අලුතින් සම්බන්ධ වන විට)
    if (!sock.authState.creds.registered && res) {
        await delay(2000);
        try {
            const code = await sock.requestPairingCode(number);
            if (!res.headersSent) {
                res.json({ code: code?.match(/.{1,4}/g)?.join('-') || code });
            }
        } catch (err) {
            if (!res.headersSent) {
                res.status(500).json({ error: 'Pairing code generation failed. Check number.' });
            }
        }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(`✅ Connected: ${number}`);
            activeSessions.set(number, sock);
            // සම්බන්ධ වූ බවට තහවුරු කිරීමේ පණිවිඩයක් යැවීම
            await sock.sendMessage(`${number}@s.whatsapp.net`, {
                text: `✦ *STAR WEB BOT CONNECTED!* ✦\n\nභාවිතා කරන ආකාරය:\n1️⃣ API Key එක සෙට් කිරීමට:\n*.set api ඔයාගේ_GEMINI_API_KEY*\n\n2️⃣ බොට්ට කතා කිරීමට:\n*mack* කියලා මුලට දාලා ඕනෑම දෙයක් අහන්න.\n(උදා: _mack මට api ගන්න site දෙන්න_)`
            });
        } else if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                startBotSession(number);
            } else {
                console.log(`❌ Logged out: ${number}`);
                fs.removeSync(sessionDir);
                activeSessions.delete(number);
            }
        }
    });

    // මැසේජ් හැසිරවීම
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const cleanText = text.trim();

        // 1. .set api command එක පරීක්ෂා කිරීම
        if (cleanText.toLowerCase().startsWith('.set api ')) {
            const apiKey = cleanText.slice(9).trim();
            if (!apiKey) {
                return await sock.sendMessage(from, { text: '⚠️ කරුණාකර නිවැරදි API Key එකක් ලබා දෙන්න.\nඋදා: `.set api AIzaSy...`' }, { quoted: msg });
            }
            setUserApi(number, apiKey);
            return await sock.sendMessage(from, { text: '✅ *API Key එක සාර්ථකව සේව් වුණා!* දැන් ඔයාට `mack` කියලා කතා කරන්න පුළුවන්.' }, { quoted: msg });
        }

        // 2. "mack" කියලා කතා කළොත් පමණක් ක්‍රියාත්මක වීම
        if (cleanText.toLowerCase().startsWith('mack')) {
            const prompt = cleanText.slice(4).trim();
            if (!prompt) {
                return await sock.sendMessage(from, { text: 'ඔව් කියන්න! මම Mack. මම ඔයාට කොහොමද උදව් කරන්න ඕන?' }, { quoted: msg });
            }

            const userApiKey = getUserApi(number);
            if (!userApiKey) {
                return await sock.sendMessage(from, {
                    text: '⚠️ ඔයා තාම API Key එකක් සෙට් කරලා නැහැ!\nමුලින්ම `.set api ඔයාගේ_API_KEY` ලෙස යවා API එක සෙට් කරන්න.'
                }, { quoted: msg });
            }

            // Typing indicator එක පෙන්වීම
            await sock.sendPresenceUpdate('composing', from);

            try {
                // Google Gemini API එක හරහා පිළිතුරු ලබා ගැනීම
                const response = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${userApiKey}`,
                    {
                        contents: [{
                            parts: [{
                                text: `You are Mack, a smart and friendly Sinhala/English WhatsApp AI assistant. Answer clearly and helpfully in the language the user asks (mostly Sinhala). User asks: ${prompt}`
                            }]
                        }]
                    }
                );

                const reply = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'සමාවෙන්න, පිළිතුරක් ලබා ගැනීමට නොහැකි වුණා.';
                await sock.sendMessage(from, { text: reply }, { quoted: msg });

            } catch (error) {
                console.error('AI Error:', error?.response?.data || error.message);
                await sock.sendMessage(from, {
                    text: '❌ API Error එකක් ආවා! ඔයා දාපු API Key එක නිවැරදිද කියලා ආපහු `.set api` ගහලා පරීක්ෂා කරන්න.'
                }, { quoted: msg });
            }
        }
    });
}

// Website එකෙන් Pairing Code ඉල්ලන Endpoint එක
app.get('/pair', async (req, res) => {
    const number = req.query.number?.replace(/[^0-9]/g, '');
    if (!number) return res.status(400).json({ error: 'Invalid phone number' });

    await startBotSession(number, res);
});

// Server එක Restart වුණොත් කලින් Pair වෙලා හිටපු අයව ආපහු Connect කිරීම
async function restoreExistingSessions() {
    if (fs.existsSync('./sessions')) {
        const folders = fs.readdirSync('./sessions');
        for (const number of folders) {
            console.log(`🔄 Restoring session for: ${number}`);
            await startBotSession(number);
        }
    }
}

app.listen(PORT, () => {
    console.log(`🚀 STAR WEB Server running on port ${PORT}`);
    restoreExistingSessions();
});
