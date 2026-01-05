import { createReadStream, existsSync, unlinkSync } from "fs";
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

const EMAIL_CONFIG = {
  host: process.env.EMAIL_HOST ?? "smtp.gmail.com",
  port: parseInt(process.env.EMAIL_PORT ?? "587"),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER ?? "",
    pass: process.env.EMAIL_PASS ?? "",
  },
};

interface UserState {
  step: "idle" | "waiting_numbers" | "waiting_message";
  numbers: string[];
}

const userStates = new Map<string, UserState>();

const getState = (from: string): UserState => {
  if (!userStates.has(from)) {
    userStates.set(from, { step: "idle", numbers: [] });
  }
  return userStates.get(from)!;
};

const resetState = (from: string) => {
  userStates.set(from, { step: "idle", numbers: [] });
};

const normalizePeruNumber = (number: string): string | null => {
  const cleaned = number.replace(/[\s\-()+]/g, "");

  if (!/^\d+$/.test(cleaned)) return null;

  if (cleaned.startsWith("9") && cleaned.length === 9) {
    return `51${cleaned}`;
  }

  if (cleaned.startsWith("51") && cleaned.length === 11) {
    if (cleaned.charAt(2) === "9") {
      return cleaned;
    }
  }

  return null;
};

const extractNumbers = (text: string): string[] => {
  const patterns = text.match(/\b(?:51)?9\d{8}\b/g) || [];

  const validNumbers: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    const normalized = normalizePeruNumber(pattern);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      validNumbers.push(normalized);
    }
  }

  return validNumbers;
};

const extractNumbersFromLines = (text: string): string[] => {
  const lines = text.split(/[\r\n]+/);
  const validNumbers: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const cleanLine = line.trim();
    if (!cleanLine) continue;

    const normalized = normalizePeruNumber(cleanLine);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      validNumbers.push(normalized);
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
      const firstColumn = line.split(/[,;]/)[0].trim();
      if (!firstColumn) return;

      const normalized = normalizePeruNumber(firstColumn);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        numbers.push(normalized);
      }
    });

    rl.on("close", () => {
      resolve(numbers);
    });

    rl.on("error", (err) => {
      reject(err);
    });
  });
};

const sendBulkWhatsApp = async (
  provider: Provider,
  numbers: string[],
  message: string,
  onProgress?: (sent: number, total: number) => void,
): Promise<{ success: number; failed: number }> => {
  let success = 0;
  let failed = 0;

  for (let index = 0; index < numbers.length; index++) {
    const number = numbers[index];
    const jid = `${number}@s.whatsapp.net`;

    const baseDelay = Math.floor(Math.random() * 5) + 3;
    const accumulatedDelay = baseDelay * 1000 * (index + 1);

    await new Promise((resolve) => setTimeout(resolve, index === 0 ? 0 : accumulatedDelay - (baseDelay * 1000 * index)));

    if (index > 0) {
      const waitTime = Math.floor(Math.random() * 5000) + 3000;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    try {
      await provider.sendMessage(jid, message, {});
      success++;
      console.log(`[${index + 1}/${numbers.length}] Enviado a ${number}`);
    } catch (error) {
      failed++;
      console.error(`[${index + 1}/${numbers.length}] Error enviando a ${number}:`, error);
    }

    if (onProgress) {
      onProgress(index + 1, numbers.length);
    }
  }

  return { success, failed };
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
    resetState(ctx.from);
    await flowDynamic("*Operacion cancelada.* Todo ha sido olvidado. Escribe *spam* para empezar de nuevo.");
  });

const spamFlow = addKeyword<Provider, Database>(["spam", "Spam", "SPAM"])
  .addAction(async (ctx, { flowDynamic }) => {
    const state = getState(ctx.from);
    state.step = "waiting_numbers";
    state.numbers = [];

    await flowDynamic([
      "*Vamos a enviar mensajes!*",
      "",
      "*Paso 1:* Enviame la lista de numeros de WhatsApp.",
      "",
      "Los numeros pueden estar:",
      "- Con codigo de pais: 51987654321",
      "- Sin codigo: 987654321",
      "",
      "Puedes enviarlos:",
      "- Separados por comas, espacios o saltos de linea",
      "- *O envia un archivo CSV* con los numeros en la primera columna",
      "",
      "Escribe *Cancel* en cualquier momento para cancelar.",
    ].join("\n"));
  });

const documentFlow = addKeyword<Provider, Database>(EVENTS.DOCUMENT)
  .addAction(async (ctx, { flowDynamic, provider, endFlow }) => {
    const state = getState(ctx.from);

    if (state.step !== "waiting_numbers") {
      await flowDynamic([
        "Recibi un documento, pero no estoy esperando uno.",
        "",
        "Escribe *spam* para iniciar el envio de mensajes.",
      ].join("\n"));
      return endFlow();
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
        await flowDynamic([
          "El archivo debe ser un CSV o TXT.",
          "",
          "Formatos aceptados:",
          "- .csv",
          "- .txt",
          "",
          "Intenta de nuevo o envia los numeros como texto.",
        ].join("\n"));
        return endFlow();
      }

      await flowDynamic("Procesando archivo...");

      const tmpDir = join(process.cwd(), "tmp");
      const savedPath = await provider.saveFile(ctx, { path: tmpDir });

      if (!savedPath) {
        await flowDynamic("No pude descargar el archivo. Intenta enviarlo de nuevo.");
        return endFlow();
      }

      console.log(`Archivo guardado en: ${savedPath}`);

      const extractedNumbers = await parseCSVFile(savedPath);

      try {
        unlinkSync(savedPath);
      } catch { /* ignore */ }

      if (extractedNumbers.length === 0) {
        await flowDynamic([
          "No encontre numeros validos en el archivo.",
          "",
          "Asegurate de que:",
          "- Los numeros esten en la primera columna",
          "- Tengan 9 digitos empezando con 9",
          "- O 11 digitos empezando con 51",
          "",
          "Intenta de nuevo o envia los numeros como texto.",
        ].join("\n"));
        return endFlow();
      }

      state.numbers = extractedNumbers;
      state.step = "waiting_message";

      const preview = extractedNumbers.slice(0, 10);
      const hasMore = extractedNumbers.length > 10;

      await flowDynamic([
        `*Archivo procesado!* Encontre ${extractedNumbers.length} numero(s) valido(s):`,
        "",
        preview.map((n) => `${n}`).join("\n"),
        hasMore ? `... y ${extractedNumbers.length - 10} mas` : "",
        "",
        "*Paso 2:* Ahora enviame el mensaje que quieres reenviar a todos.",
        "",
        "Escribe *Cancel* para cancelar.",
      ].filter(Boolean).join("\n"));

    } catch (error: any) {
      console.error("Error procesando documento:", error);
      await flowDynamic([
        "Hubo un error procesando el archivo.",
        "",
        `Error: ${error.message}`,
        "",
        "Intenta enviarlo de nuevo o envia los numeros como texto.",
      ].join("\n"));
    }

    return endFlow();
  });

const catchAllFlow = addKeyword<Provider, Database>(EVENTS.WELCOME)
  .addAction(async (ctx, { flowDynamic, provider, endFlow }) => {
    const state = getState(ctx.from);
    const userMessage = ctx.body.trim();

    if (["cancel", "cancelar"].includes(userMessage.toLowerCase())) {
      resetState(ctx.from);
      await flowDynamic("*Operacion cancelada.* Todo ha sido olvidado. Escribe *spam* para empezar de nuevo.");
      return endFlow();
    }

    if (state.step === "waiting_numbers") {
      const extractedNumbers = extractNumbers(userMessage);

      if (extractedNumbers.length === 0) {
        await flowDynamic([
          "No encontre numeros validos en tu mensaje.",
          "",
          "Recuerda que los numeros deben:",
          "- Tener 9 digitos empezando con 9",
          "- O tener 11 digitos empezando con 51",
          "",
          "Intenta de nuevo o escribe *Cancel* para cancelar.",
        ].join("\n"));
        return endFlow();
      }

      state.numbers = extractedNumbers;
      state.step = "waiting_message";

      await flowDynamic([
        `*Perfecto!* Encontre ${extractedNumbers.length} numero(s) valido(s):`,
        "",
        extractedNumbers.map((n) => `${n}`).join("\n"),
        "",
        "*Paso 2:* Ahora enviame el mensaje que quieres reenviar a todos.",
        "",
        "Escribe *Cancel* para cancelar.",
      ].join("\n"));
      return endFlow();
    }

    if (state.step === "waiting_message") {
      const numbers = state.numbers;
      const message = userMessage;

      resetState(ctx.from);

      await flowDynamic([
        "*Enviando mensajes!*",
        "",
        `Total: ${numbers.length} destinatarios`,
        "",
        "Esto puede tomar un momento para evitar spam...",
      ].join("\n"));

      const result = await sendBulkWhatsApp(provider, numbers, message);

      await flowDynamic([
        "*Envio completado!*",
        "",
        `*Resultados:*`,
        `- Enviados: ${result.success}`,
        `- Fallidos: ${result.failed}`,
        "",
        "Escribe *spam* para enviar mas mensajes.",
      ].join("\n"));

      return endFlow();
    }

    if (state.step === "idle") {
      await flowDynamic([
        "*Hola!*",
        "",
        "Comandos disponibles:",
        "- *spam* - Enviar mensajes masivos a WhatsApp",
        "",
        "Que deseas hacer?",
      ].join("\n"));
      return endFlow();
    }
  });

const main = async () => {
  const adapterFlow = createFlow([cancelFlow, spamFlow, documentFlow, catchAllFlow]);

  const adapterProvider = createProvider(Provider, {
    version: [2, 3000, 1027934701] as any,
  });

  const adapterDB = new Database({ filename: "db.json" });

  const { handleCtx, httpServer } = await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB,
  });

  adapterProvider.server.post(
    "/v1/whatsapp/bulk",
    handleCtx(async (bot, req, res) => {
      try {
        const { numbers, message } = req.body;

        if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Se requiere un array de numeros" }));
        }

        if (!message || typeof message !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Se requiere un mensaje" }));
        }

        const validNumbers: string[] = [];
        const invalidNumbers: string[] = [];

        for (const num of numbers) {
          const normalized = normalizePeruNumber(String(num));
          if (normalized) {
            validNumbers.push(normalized);
          } else {
            invalidNumbers.push(String(num));
          }
        }

        if (validNumbers.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "No se encontraron numeros validos", invalidNumbers }));
        }

        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "accepted",
          message: "Envio iniciado en segundo plano",
          validNumbers: validNumbers.length,
          invalidNumbers,
        }));

        const provider = adapterProvider;
        sendBulkWhatsApp(provider, validNumbers, message).then((result) => {
          console.log("Resultado del envio bulk:", result);
        });
      } catch (error: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: error.message }));
      }
    }),
  );

  adapterProvider.server.post(
    "/v1/messages",
    handleCtx(async (bot, req, res) => {
      const { number, message, urlMedia } = req.body;
      await bot.sendMessage(number, message, { media: urlMedia ?? null });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "sent" }));
    }),
  );

  adapterProvider.server.post(
    "/v1/email/send",
    handleCtx(async (bot, req, res) => {
      try {
        const { emails, subject, text, html } = req.body;

        if (!emails || !Array.isArray(emails) || emails.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Se requiere un array de emails" }));
        }

        if (!subject || typeof subject !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Se requiere un asunto (subject)" }));
        }

        if (!text || typeof text !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Se requiere el texto del mensaje" }));
        }

        if (!EMAIL_CONFIG.auth.user || !EMAIL_CONFIG.auth.pass) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({
            error: "Configuracion de email incompleta. Configura EMAIL_USER y EMAIL_PASS",
          }));
        }

        const result = await sendBulkEmails(emails, subject, text, html);

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          status: "completed",
          success: result.success,
          failed: result.failed,
          errors: result.errors,
        }));
      } catch (error: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: error.message }));
      }
    }),
  );

  adapterProvider.server.get(
    "/v1/email/test",
    handleCtx(async (bot, req, res) => {
      try {
        if (!EMAIL_CONFIG.auth.user || !EMAIL_CONFIG.auth.pass) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({
            status: "error",
            message: "Configuracion incompleta. Configura EMAIL_USER y EMAIL_PASS",
          }));
        }

        const transporter = nodemailer.createTransport(EMAIL_CONFIG);
        await transporter.verify();

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          status: "ok",
          message: "Configuracion de email valida",
          user: EMAIL_CONFIG.auth.user,
        }));
      } catch (error: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          status: "error",
          message: error.message,
        }));
      }
    }),
  );

  adapterProvider.server.post(
    "/v1/blacklist",
    handleCtx(async (bot, req, res) => {
      const { number, intent } = req.body;
      if (intent === "remove") bot.blacklist.remove(number);
      if (intent === "add") bot.blacklist.add(number);

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", number, intent }));
    }),
  );

  adapterProvider.server.get(
    "/v1/blacklist/list",
    handleCtx(async (bot, req, res) => {
      const blacklist = bot.blacklist.getList();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", blacklist }));
    }),
  );

  adapterProvider.server.get(
    "/v1/health",
    handleCtx(async (bot, req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        status: "ok",
        timestamp: new Date().toISOString(),
        endpoints: [
          "POST /v1/whatsapp/bulk - Envio masivo de WhatsApp",
          "POST /v1/messages - Envio individual de WhatsApp",
          "POST /v1/email/send - Envio de correos",
          "GET /v1/email/test - Verificar configuracion de email",
          "POST /v1/blacklist - Agregar/quitar de blacklist",
          "GET /v1/blacklist/list - Listar blacklist",
          "GET /v1/health - Este endpoint",
        ],
      }));
    }),
  );

  httpServer(+PORT);
  console.log(`
Bot iniciado en puerto ${PORT}

Comandos del bot:
  - spam: Iniciar envio masivo de mensajes
  - Cancel: Cancelar operacion actual

API Endpoints:
  - POST /v1/whatsapp/bulk - Envio masivo de WhatsApp
    Body: { numbers: ["51987654321", ...], message: "texto" }
  
  - POST /v1/messages - Envio individual
    Body: { number: "51987654321", message: "texto" }
  
  - POST /v1/email/send - Envio de correos
    Body: { emails: ["email@ejemplo.com", ...], subject: "Asunto", text: "Mensaje" }
  
  - GET /v1/email/test - Verificar configuracion de email
  - GET /v1/health - Estado del servidor

Variables de entorno para email:
  - EMAIL_HOST (default: smtp.gmail.com)
  - EMAIL_PORT (default: 587)
  - EMAIL_USER (tu correo)
  - EMAIL_PASS (app password)
  `);
};

main();
