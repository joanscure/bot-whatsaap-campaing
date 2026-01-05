import { createReadStream, existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import {
  createBot,
  createProvider,
  createFlow,
  addKeyword,
  EVENTS,
} from "@builderbot/bot";
import { JsonFileDB as Database } from "@builderbot/database-json";
import { BaileysProvider as Provider } from "@builderbot/provider-baileys";
import nodemailer from "nodemailer";

const PORT = process.env.PORT ?? 3008;
const BOT_SECRET_KEY = process.env.BOT_SECRET_KEY ?? "clave-whatsapp";

const EMAIL_CONFIG = {
  host: process.env.EMAIL_HOST ?? "smtp.gmail.com",
  port: parseInt(process.env.EMAIL_PORT ?? "587"),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER ?? "",
    pass: process.env.EMAIL_PASS ?? "",
  },
};

const authenticatedUsers = new Set<string>();

interface UserState {
  step: "idle" | "waiting_numbers" | "confirming_numbers" | "waiting_messages" | "confirming_messages";
  numbers: string[];
  messages: string[];
}

const userStates = new Map<string, UserState>();

const getState = (from: string): UserState => {
  if (!userStates.has(from)) {
    userStates.set(from, { step: "idle", numbers: [], messages: [] });
  }
  return userStates.get(from)!;
};

const resetState = (from: string) => {
  userStates.set(from, { step: "idle", numbers: [], messages: [] });
};

const addNumbersToState = (state: UserState, newNumbers: string[]): number => {
  const existing = new Set(state.numbers);
  let added = 0;
  for (const num of newNumbers) {
    if (!existing.has(num)) {
      state.numbers.push(num);
      existing.add(num);
      added++;
    }
  }
  return added;
};

const normalizePeruNumber = (number: string): string | null => {
  const cleaned = number.replace(/[^\d]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  if (cleaned.startsWith("9") && cleaned.length === 9) {
    return `51${cleaned}`;
  }
  if (cleaned.startsWith("51") && cleaned.length === 11 && cleaned.charAt(2) === "9") {
    return cleaned;
  }
  return null;
};

const extractNumbers = (text: string): string[] => {
  const validNumbers: string[] = [];
  const seen = new Set<string>();
  const lines = text.split(/[\r\n,;]+/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const normalized = normalizePeruNumber(trimmed);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      validNumbers.push(normalized);
    }
  }
  if (validNumbers.length === 0) {
    const patterns = text.match(/(?:\+?\s*51\s*)?9[\d\s\-().]{8,20}/g) || [];
    for (const pattern of patterns) {
      const normalized = normalizePeruNumber(pattern);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        validNumbers.push(normalized);
      }
    }
  }
  return validNumbers;
};

const parseCSVFile = async (filePath: string): Promise<string[]> => {
  return new Promise((resolve, reject) => {
    if (!existsSync(filePath)) {
      reject(new Error("Archivo no encontrado"));
      return;
    }
    const numbers: string[] = [];
    const seen = new Set<string>();
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      const firstColumn = line.split(/[,;\t]/)[0].trim();
      if (!firstColumn) return;
      const normalized = normalizePeruNumber(firstColumn);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        numbers.push(normalized);
      }
    });
    rl.on("close", () => resolve(numbers));
    rl.on("error", (err) => reject(err));
  });
};

const sendBulkWhatsApp = async (
  provider: Provider,
  numbers: string[],
  messages: string[],
  onProgress?: (sent: number, total: number) => void,
): Promise<{ success: number; failed: number; notOnWhatsApp: number }> => {
  let success = 0;
  let failed = 0;
  let notOnWhatsApp = 0;

  for (let index = 0; index < numbers.length; index++) {
    const number = numbers[index];
    const jid = `${number}@s.whatsapp.net`;

    if (index > 0) {
      const waitTime = Math.floor(Math.random() * 5000) + 3000;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    try {
      let hasWhatsApp = true;
      try {
        if (provider.vendor && typeof provider.vendor.onWhatsApp === "function") {
          const result = await provider.vendor.onWhatsApp(number);
          if (result && result[0]) {
            hasWhatsApp = result[0].exists === true;
          }
        }
      } catch { hasWhatsApp = true; }

      if (!hasWhatsApp) {
        notOnWhatsApp++;
        console.log(`[${index + 1}/${numbers.length}] ${number} no tiene WhatsApp`);
        continue;
      }

      for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
        const message = messages[msgIndex];
        await provider.sendMessage(jid, message, {});
        if (msgIndex < messages.length - 1) {
          const msgDelay = Math.floor(Math.random() * 2000) + 1000;
          await new Promise((resolve) => setTimeout(resolve, msgDelay));
        }
      }
      success++;
      console.log(`[${index + 1}/${numbers.length}] Enviado a ${number} (${messages.length} mensaje(s))`);
    } catch (error) {
      failed++;
      console.error(`[${index + 1}/${numbers.length}] Error enviando a ${number}:`, error);
    }

    if (onProgress) onProgress(index + 1, numbers.length);
  }
  return { success, failed, notOnWhatsApp };
};

const sendBulkEmails = async (
  emails: string[],
  subject: string,
  text: string,
  html?: string,
): Promise<{ success: number; failed: number; errors: string[] }> => {
  const transporter = nodemailer.createTransport(EMAIL_CONFIG);
  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const email of emails) {
    try {
      await transporter.sendMail({
        from: EMAIL_CONFIG.auth.user,
        to: email,
        subject,
        text,
        html: html ?? text,
      });
      success++;
      console.log(`Email enviado a ${email}`);
    } catch (error: any) {
      failed++;
      errors.push(`${email}: ${error.message}`);
      console.error(`Error enviando email a ${email}:`, error.message);
    }
  }
  return { success, failed, errors };
};

const cancelFlow = addKeyword<Provider, Database>(["Cancel", "cancel", "CANCEL", "Cancelar", "cancelar"])
  .addAction(async (ctx, { flowDynamic }) => {
    if (!authenticatedUsers.has(ctx.from)) return;
    resetState(ctx.from);
    authenticatedUsers.delete(ctx.from);
    await flowDynamic("*Operacion cancelada.* Sesion cerrada. Escribe la clave para empezar de nuevo.");
  });

const spamFlow = addKeyword<Provider, Database>(["spam", "Spam", "SPAM"])
  .addAction(async (ctx, { flowDynamic }) => {
    if (!authenticatedUsers.has(ctx.from)) return;

    const state = getState(ctx.from);
    state.step = "waiting_numbers";
    state.numbers = [];
    state.messages = [];

    await flowDynamic([
      "*Vamos a enviar mensajes!*",
      "",
      "*Paso 1:* Enviame la lista de numeros de WhatsApp.",
      "",
      "Los numeros pueden estar en formato:",
      "- 987654321",
      "- 51987654321",
      "- +51 987 654 321",
      "",
      "Puedes enviarlos:",
      "- Uno por linea",
      "- Separados por comas",
      "- *O envia un archivo CSV*",
      "",
      "Escribe *Cancel* para cancelar y cerrar sesion.",
    ].join("\n"));
  });

const documentFlow = addKeyword<Provider, Database>(EVENTS.DOCUMENT)
  .addAction(async (ctx, { flowDynamic, provider }) => {
    if (!authenticatedUsers.has(ctx.from)) return;

    const state = getState(ctx.from);

    if (state.step !== "waiting_numbers" && state.step !== "confirming_numbers") {
      await flowDynamic("Recibi un documento, pero no estoy esperando uno. Escribe *spam* para iniciar.");
      return;
    }

    try {
      const mimeType = ctx.message?.documentMessage?.mimetype || "";
      const fileName = ctx.message?.documentMessage?.fileName || "documento";
      console.log(`Documento recibido: ${fileName} (${mimeType})`);

      const validTypes = ["text/csv", "text/plain", "application/csv", "application/vnd.ms-excel"];
      const isValidType = validTypes.some((t) => mimeType.includes(t)) ||
        fileName.toLowerCase().endsWith(".csv") ||
        fileName.toLowerCase().endsWith(".txt");

      if (!isValidType) {
        await flowDynamic("El archivo debe ser un CSV o TXT. Intenta de nuevo.");
        return;
      }

      await flowDynamic("Procesando archivo...");
      const tmpDir = join(process.cwd(), "tmp");
      if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

      const savedPath = await provider.saveFile(ctx, { path: tmpDir });
      if (!savedPath) {
        await flowDynamic("No pude descargar el archivo. Intenta enviarlo de nuevo.");
        return;
      }

      console.log(`Archivo guardado en: ${savedPath}`);
      const extractedNumbers = await parseCSVFile(savedPath);
      try { unlinkSync(savedPath); } catch { /* ignore */ }

      if (extractedNumbers.length === 0) {
        await flowDynamic("No encontre numeros validos en el archivo. Intenta de nuevo.");
        return;
      }

      const added = addNumbersToState(state, extractedNumbers);
      state.step = "confirming_numbers";

      const preview = state.numbers.slice(0, 10);
      const hasMore = state.numbers.length > 10;

      await flowDynamic([
        `*Archivo procesado!* Se agregaron ${added} numero(s) nuevo(s).`,
        "",
        `*Total actual: ${state.numbers.length} numero(s)*`,
        "",
        preview.join("\n"),
        hasMore ? `... y ${state.numbers.length - 10} mas` : "",
        "",
        "- Envia mas numeros para agregarlos",
        "- Escribe *Confirmar* para pasar a los mensajes",
        "- Escribe *Cancel* para cancelar",
      ].filter(Boolean).join("\n"));

    } catch (error: any) {
      console.error("Error procesando documento:", error);
      await flowDynamic(`Hubo un error: ${error.message}`);
    }
  });

const catchAllFlow = addKeyword<Provider, Database>(EVENTS.WELCOME)
  .addAction(async (ctx, { flowDynamic, provider }) => {
    const state = getState(ctx.from);
    const userMessage = ctx.body.trim();

    if (["cancel", "cancelar"].includes(userMessage.toLowerCase())) {
      if (!authenticatedUsers.has(ctx.from)) return;
      resetState(ctx.from);
      authenticatedUsers.delete(ctx.from);
      await flowDynamic("*Operacion cancelada.* Sesion cerrada. Escribe la clave para empezar de nuevo.");
      return;
    }

    if (!authenticatedUsers.has(ctx.from)) {
      if (userMessage === BOT_SECRET_KEY) {
        authenticatedUsers.add(ctx.from);
        await flowDynamic([
          "*Acceso concedido!*",
          "",
          "Ahora puedes usar el bot.",
          "Escribe *spam* para empezar a enviar mensajes.",
          "",
          "Escribe *Cancel* para cerrar sesion.",
        ].join("\n"));
      }
      return;
    }

    if (state.step === "waiting_numbers" || state.step === "confirming_numbers") {
      if (["confirmar", "confirm", "ok", "listo"].includes(userMessage.toLowerCase())) {
        if (state.numbers.length === 0) {
          await flowDynamic("No tienes numeros en la lista todavia. Envia numeros primero.");
          return;
        }
        state.step = "waiting_messages";
        state.messages = [];
        await flowDynamic([
          `*Lista confirmada!* Total: ${state.numbers.length} numero(s)`,
          "",
          "*Paso 2:* Ahora enviame los mensajes que quieres enviar.",
          "",
          "Puedes enviar varios mensajes. Cada uno se enviara por separado.",
          "Cuando termines, escribe exactamente *Enviar* para iniciar el envio.",
          "",
          "Escribe *Cancel* para cancelar.",
        ].join("\n"));
        return;
      }

      const extractedNumbers = extractNumbers(userMessage);
      if (extractedNumbers.length === 0) {
        const msg = state.step === "confirming_numbers"
          ? "No encontre numeros validos. Escribe *Confirmar* si ya terminaste o envia mas numeros."
          : "No encontre numeros validos. Formatos: 987654321, 51987654321, +51 987 654 321";
        await flowDynamic(msg);
        return;
      }

      const added = addNumbersToState(state, extractedNumbers);
      state.step = "confirming_numbers";

      const preview = state.numbers.slice(0, 10);
      const hasMore = state.numbers.length > 10;

      await flowDynamic([
        `*Perfecto!* Se agregaron ${added} numero(s) nuevo(s).`,
        "",
        `*Total actual: ${state.numbers.length} numero(s)*`,
        "",
        preview.join("\n"),
        hasMore ? `... y ${state.numbers.length - 10} mas` : "",
        "",
        "- Envia mas numeros para agregarlos",
        "- Escribe *Confirmar* para pasar a los mensajes",
        "- Escribe *Cancel* para cancelar",
      ].filter(Boolean).join("\n"));
      return;
    }

    if (state.step === "waiting_messages" || state.step === "confirming_messages") {
      if (userMessage === "Enviar") {
        if (state.messages.length === 0) {
          await flowDynamic("No tienes mensajes guardados todavia. Envia al menos un mensaje.");
          return;
        }

        await flowDynamic([
          "*Iniciando envio!*",
          "",
          `Destinatarios: ${state.numbers.length}`,
          `Mensajes por destinatario: ${state.messages.length}`,
          "",
          "Esto puede tomar un momento...",
        ].join("\n"));

        const numbers = [...new Set(state.numbers)];
        const messages = [...state.messages];
        resetState(ctx.from);

        const result = await sendBulkWhatsApp(provider, numbers, messages);

        await flowDynamic([
          "*Envio completado!*",
          "",
          `*Resultados:*`,
          `- Enviados: ${result.success}`,
          `- Fallidos: ${result.failed}`,
          `- Sin WhatsApp: ${result.notOnWhatsApp}`,
          "",
          "Escribe *spam* para enviar mas mensajes.",
        ].join("\n"));
        return;
      }

      state.messages.push(userMessage);
      state.step = "confirming_messages";

      await flowDynamic([
        `*Mensaje ${state.messages.length} guardado!*`,
        "",
        `Tienes ${state.messages.length} mensaje(s) en cola:`,
        ...state.messages.map((m, i) => `${i + 1}. "${m.substring(0, 50)}${m.length > 50 ? "..." : ""}"`),
        "",
        "- Envia otro mensaje para agregarlo",
        "- Escribe exactamente *Enviar* para iniciar el envio",
        "- Escribe *Cancel* para cancelar",
      ].join("\n"));
      return;
    }

    if (state.step === "idle") {
      await flowDynamic([
        "*Sesion activa*",
        "",
        "Comandos disponibles:",
        "- *spam* - Enviar mensajes masivos",
        "- *Cancel* - Cerrar sesion",
      ].join("\n"));
    }
  });

const main = async () => {
  const adapterFlow = createFlow([cancelFlow, spamFlow, documentFlow, catchAllFlow]);
  const adapterProvider = createProvider(Provider, { version: [2, 3000, 1027934701] as any });
  const adapterDB = new Database({ filename: "db.json" });

  const { handleCtx, httpServer } = await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB,
  });

  adapterProvider.server.post("/v1/whatsapp/bulk", handleCtx(async (bot, req, res) => {
    try {
      const { numbers, message, messages } = req.body;
      if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Se requiere un array de numeros" }));
      }
      const messageList: string[] = messages && Array.isArray(messages) ? messages : (message ? [message] : []);
      if (messageList.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Se requiere al menos un mensaje" }));
      }
      const validNumbers: string[] = [];
      const invalidNumbers: string[] = [];
      for (const num of numbers) {
        const normalized = normalizePeruNumber(String(num));
        if (normalized) validNumbers.push(normalized);
        else invalidNumbers.push(String(num));
      }
      if (validNumbers.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "No se encontraron numeros validos", invalidNumbers }));
      }
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "accepted", validNumbers: validNumbers.length, messageCount: messageList.length, invalidNumbers }));
      const uniqueNumbers = [...new Set(validNumbers)];
      sendBulkWhatsApp(adapterProvider, uniqueNumbers, messageList).then((result) => console.log("Resultado:", result));
    } catch (error: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: error.message }));
    }
  }));

  adapterProvider.server.post("/v1/messages", handleCtx(async (bot, req, res) => {
    const { number, message, urlMedia } = req.body;
    await bot.sendMessage(number, message, { media: urlMedia ?? null });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "sent" }));
  }));

  adapterProvider.server.post("/v1/email/send", handleCtx(async (bot, req, res) => {
    try {
      const { emails, subject, text, html } = req.body;
      if (!emails || !Array.isArray(emails) || emails.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Se requiere un array de emails" }));
      }
      if (!subject || !text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Se requiere subject y text" }));
      }
      if (!EMAIL_CONFIG.auth.user || !EMAIL_CONFIG.auth.pass) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Configuracion de email incompleta" }));
      }
      const result = await sendBulkEmails(emails, subject, text, html);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "completed", ...result }));
    } catch (error: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: error.message }));
    }
  }));

  adapterProvider.server.get("/v1/email/test", handleCtx(async (bot, req, res) => {
    try {
      if (!EMAIL_CONFIG.auth.user || !EMAIL_CONFIG.auth.pass) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "error", message: "Configuracion incompleta" }));
      }
      const transporter = nodemailer.createTransport(EMAIL_CONFIG);
      await transporter.verify();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", user: EMAIL_CONFIG.auth.user }));
    } catch (error: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "error", message: error.message }));
    }
  }));

  adapterProvider.server.post("/v1/blacklist", handleCtx(async (bot, req, res) => {
    const { number, intent } = req.body;
    if (intent === "remove") bot.blacklist.remove(number);
    if (intent === "add") bot.blacklist.add(number);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", number, intent }));
  }));

  adapterProvider.server.get("/v1/blacklist/list", handleCtx(async (bot, req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", blacklist: bot.blacklist.getList() }));
  }));

  adapterProvider.server.get("/v1/health", handleCtx(async (bot, req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
  }));

  httpServer(+PORT);
  console.log(`Bot iniciado en puerto ${PORT}. Clave secreta: ${BOT_SECRET_KEY}`);
};

main();
