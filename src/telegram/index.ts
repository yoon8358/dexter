/**
 * Dexter Telegram control tower.
 *
 * Long-polls the Telegram Bot API (no webhook / public URL needed) and routes
 * messages from allowed chats into Dexter's agent via runAgentForMessage().
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN        (required) token from @BotFather
 *   TELEGRAM_ALLOWED_CHAT_IDS (required) comma-separated chat IDs allowed to use the bot
 *   DEXTER_MODEL              (optional) model id, default: Dexter's DEFAULT_MODEL
 *   DEXTER_PROVIDER           (optional) provider id, default: openai
 *   DEXTER_MAX_ITERATIONS     (optional) agent step limit, default: 15
 */
import { mkdirSync } from 'node:fs';
import { runAgentForMessage, isSessionRunning, enqueueForSession } from '../gateway/agent-runner.js';
import { DEFAULT_MODEL } from '../model/llm.js';
import { getDexterDir } from '../utils/paths.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
let model = process.env.DEXTER_MODEL?.trim() || DEFAULT_MODEL;
const provider = process.env.DEXTER_PROVIDER?.trim() || 'openai';
const MAX_ITERATIONS = Number(process.env.DEXTER_MAX_ITERATIONS) || 15;

if (!TOKEN) {
  console.error('[telegram] TELEGRAM_BOT_TOKEN is not set. Exiting.');
  process.exit(1);
}
if (ALLOWED.size === 0) {
  console.warn('[telegram] TELEGRAM_ALLOWED_CHAT_IDS is empty: the bot will only reply with your chat ID.');
}

mkdirSync(getDexterDir(), { recursive: true });

const API = `https://api.telegram.org/bot${TOKEN}`;
const MAX_MSG = 4000; // Telegram hard limit is 4096

async function tg<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!data.ok) throw new Error(`${method}: ${data.description ?? res.status}`);
  return data.result;
}

function chunk(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_MSG) {
    let cut = rest.lastIndexOf('\n', MAX_MSG);
    if (cut < MAX_MSG / 2) cut = MAX_MSG;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim()) out.push(rest);
  return out;
}

async function send(chatId: number | string, text: string): Promise<number | undefined> {
  let lastId: number | undefined;
  for (const part of chunk(text)) {
    const msg = await tg<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: part,
      disable_web_page_preview: true,
    });
    lastId = msg.message_id;
  }
  return lastId;
}

/** Strip markdown the model may still emit, since we send plain text. */
function toPlain(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|\s)\*(\S[^*\n]*?)\*(?=\s|$|[.,!?])/g, '$1$2')
    .trim();
}

// Session generation per chat so /reset starts a fresh conversation.
const sessionGen = new Map<string, number>();
const sessionKeyFor = (chatId: string) => `telegram:${chatId}:${sessionGen.get(chatId) ?? 0}`;

const HELP = [
  'Dexter 연구소 봇',
  '',
  '질문을 그냥 보내면 Dexter가 분석합니다.',
  '예) 코스트코의 최근 5년 ROIC와 FCF 추세를 분석해줘',
  '',
  '/reset  대화 맥락 초기화',
  '/model  현재 모델 보기 (/model <id> 로 변경)',
  '/id     내 chat ID 확인',
].join('\n');

async function handleText(chatId: string, text: string): Promise<void> {
  const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();

  if (cmd === '/id' || (cmd === '/start' && !ALLOWED.has(chatId))) {
    await send(chatId, `chat ID: ${chatId}`);
    return;
  }
  if (!ALLOWED.has(chatId)) return; // silently ignore strangers

  if (cmd === '/start' || cmd === '/help') {
    await send(chatId, HELP);
    return;
  }
  if (cmd === '/reset') {
    sessionGen.set(chatId, (sessionGen.get(chatId) ?? 0) + 1);
    await send(chatId, '대화 맥락을 초기화했어요.');
    return;
  }
  if (cmd === '/model') {
    const arg = text.split(/\s+/)[1];
    if (arg) model = arg;
    await send(chatId, `모델: ${model} (provider: ${provider})`);
    return;
  }

  const sessionKey = sessionKeyFor(chatId);
  if (isSessionRunning(sessionKey)) {
    enqueueForSession(sessionKey, model, text);
    await send(chatId, '분석 진행 중이라 이 메시지를 이어서 반영할게요.');
    return;
  }

  const statusId = await send(chatId, '분석 시작…');
  const tools: string[] = [];
  let lastEdit = 0;
  const typing = setInterval(() => {
    tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }, 4500);
  tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  const started = Date.now();
  try {
    const answer = await runAgentForMessage({
      sessionKey,
      query: text,
      model,
      modelProvider: provider,
      channel: 'whatsapp', // mobile-friendly profile (no tables/headers)
      maxIterations: MAX_ITERATIONS,
      onEvent: async (event) => {
        if (event.type !== 'tool_start' || !statusId) return;
        tools.push(event.tool);
        if (Date.now() - lastEdit < 3000) return; // avoid Telegram rate limits
        lastEdit = Date.now();
        await tg('editMessageText', {
          chat_id: chatId,
          message_id: statusId,
          text: `분석 중… (도구 ${tools.length}회)\n최근: ${tools.slice(-3).join(', ')}`,
        }).catch(() => {});
      },
    });
    const secs = Math.round((Date.now() - started) / 1000);
    if (statusId) {
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: statusId,
        text: `완료 (${secs}초, 도구 ${tools.length}회)`,
      }).catch(() => {});
    }
    await send(chatId, toPlain(answer) || '(빈 응답)');
    console.log(`[telegram] chat=${chatId} done in ${secs}s, tools=${tools.length}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[telegram] agent error: ${msg}`);
    await send(chatId, `오류가 났어요: ${msg.slice(0, 500)}`).catch(() => {});
  } finally {
    clearInterval(typing);
  }
}

// Per-chat serialization so one chat's runs don't interleave.
const chatTails = new Map<string, Promise<void>>();
function dispatch(chatId: string, text: string): void {
  const prev = chatTails.get(chatId) ?? Promise.resolve();
  const next = prev.then(() => handleText(chatId, text)).catch((e) => console.error('[telegram]', e));
  chatTails.set(chatId, next);
}

type Update = {
  update_id: number;
  message?: { chat: { id: number }; text?: string; from?: { username?: string } };
};

async function main(): Promise<void> {
  const me = await tg<{ username: string }>('getMe');
  console.log(`[telegram] running as @${me.username}, model=${model}, allowed=${[...ALLOWED].join(',') || '(none)'}`);
  await tg('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  await tg('setMyCommands', {
    commands: [
      { command: 'help', description: '사용법' },
      { command: 'reset', description: '대화 맥락 초기화' },
      { command: 'model', description: '모델 보기/변경' },
      { command: 'id', description: '내 chat ID' },
    ],
  }).catch(() => {});

  let offset = 0;
  for (;;) {
    try {
      const updates = await tg<Update[]>('getUpdates', {
        offset,
        timeout: 50,
        allowed_updates: ['message'],
      });
      for (const u of updates) {
        offset = u.update_id + 1;
        const text = u.message?.text?.trim();
        if (!text) continue;
        dispatch(String(u.message!.chat.id), text);
      }
    } catch (err) {
      console.error('[telegram] polling error:', err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

process.on('SIGTERM', () => process.exit(0));
main().catch((err) => {
  console.error('[telegram] fatal:', err);
  process.exit(1);
});
