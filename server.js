import express from "express";
import cors from "cors";

const app = express();
app.use(express.json());

// === CONFIG via env (Render -> Environment Variables) ===
const PLUGGY_CLIENT_ID = process.env.PLUGGY_CLIENT_ID;
const PLUGGY_CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET;

// Coloque aqui a URL do seu GitHub Pages (pra liberar CORS)
// ex: https://enzo-user.github.io/seu-repo
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

// CORS (se quiser travar só no seu site, deixe FRONTEND_ORIGIN certinho)
app.use(
  cors({
    origin: FRONTEND_ORIGIN === "*" ? true : FRONTEND_ORIGIN,
  })
);

function mustEnv() {
  if (!PLUGGY_CLIENT_ID || !PLUGGY_CLIENT_SECRET) {
    throw new Error("Faltam PLUGGY_CLIENT_ID e/ou PLUGGY_CLIENT_SECRET nas env vars.");
  }
}

// 1) Cria API Key (dura 2 horas) via /auth
async function pluggyCreateApiKey() {
  mustEnv();
  const r = await fetch("https://api.pluggy.ai/auth", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ clientId: PLUGGY_CLIENT_ID, clientSecret: PLUGGY_CLIENT_SECRET }),
  });
  if (!r.ok) throw new Error(`Pluggy /auth falhou: ${r.status}`);
  const data = await r.json();
  return data.apiKey;
}

// 2) Cria Connect Token (dura 30 min) via /connect_token
async function pluggyCreateConnectToken({ apiKey, clientUserId, itemId }) {
  // itemId opcional: se você quiser abrir em modo "update"
  const payload = {
    options: {
      clientUserId: clientUserId || "user",
      avoidDuplicates: true // Nubank suporta evitar duplicados :contentReference[oaicite:3]{index=3}
    }
  };
  if (itemId) payload.itemId = itemId;

  const r = await fetch("https://api.pluggy.ai/connect_token", {
    method: "POST",
    headers: {
        "content-type": "application/json",
        accept: "application/json",
        "X-API-KEY": apiKey
    },
    body: JSON.stringify(payload),
    });
  if (!r.ok) throw new Error(`Pluggy /connect_token falhou: ${r.status}`);
  return r.json();
}

// 3) Lista contas do item
async function pluggyListAccounts({ apiKey, itemId }) {
  const url = new URL("https://api.pluggy.ai/accounts");
  url.searchParams.set("itemId", itemId);

  const r = await fetch(url.toString(), {
    headers: { accept: "application/json", "X-API-KEY": apiKey },
  });
  if (!r.ok) throw new Error(`Pluggy /accounts falhou: ${r.status}`);
  return r.json();
}

// 4) Lista transações de uma conta
async function pluggyListTransactions({ apiKey, accountId, from, to }) {
  const url = new URL("https://api.pluggy.ai/transactions");
  url.searchParams.set("accountId", accountId);
  if (from) url.searchParams.set("from", from);
  if (to) url.searchParams.set("to", to);

  const r = await fetch(url.toString(), {
    headers: { accept: "application/json", "X-API-KEY": apiKey },
  });
  if (!r.ok) throw new Error(`Pluggy /transactions falhou: ${r.status}`);
  return r.json();
}

app.get("/health", (_, res) => res.send("ok"));

// Endpoint que seu GitHub Pages vai chamar para abrir o widget (gera connect token)
app.post("/connect-token", async (req, res) => {
  try {
    const { clientUserId, itemId } = req.body || {};
    const apiKey = await pluggyCreateApiKey(); // :contentReference[oaicite:4]{index=4}
    const tokenData = await pluggyCreateConnectToken({ apiKey, clientUserId, itemId }); // :contentReference[oaicite:5]{index=5}
    res.json({ connectToken: tokenData.accessToken || tokenData.connectToken });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Endpoint pra sincronizar transações (você manda itemId)
app.post("/sync", async (req, res) => {
  try {
    const { itemId, from, to } = req.body || {};
    if (!itemId) return res.status(400).json({ error: "Faltou itemId" });

    const apiKey = await pluggyCreateApiKey();

    // pega contas do item
    const accounts = await pluggyListAccounts({ apiKey, itemId });

    // validação simples YYYY-MM-DD
    const isISO = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

    let fromStr, toStr;

    if (isISO(from) && isISO(to) && from <= to) {
      fromStr = from;
      toStr = to;
    } else {
      // DEFAULT: últimos 1 dia
      const toD = new Date();
      const fromD = new Date();
      fromD.setDate(fromD.getDate() - 1);
      fromStr = fromD.toISOString().slice(0, 10);
      toStr = toD.toISOString().slice(0, 10);
    }

    const out = [];

    for (const acc of accounts.results || []) {
      const tx = await pluggyListTransactions({
        apiKey,
        accountId: acc.id,
        from: fromStr,
        to: toStr,
      });

      for (const t of tx.results || []) {
        const signed =
          t.type === "CREDIT" ? Number(t.amount || 0) : -Math.abs(Number(t.amount || 0));

        out.push({
          id: t.id,
          date: (t.date || "").slice(0, 10),
          description: t.description || "",
          amountSigned: signed,
          accountName: acc.name || "Nubank",
          isCreditCard: acc.type === "CREDIT",
        });
      }
    }

    res.json({ transactions: out });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port));