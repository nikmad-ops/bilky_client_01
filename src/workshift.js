import { chromium } from "playwright-core";
import fs from "node:fs";

const {
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  ADMIN_TELEGRAM_BOT_TOKEN,
  ADMIN_TELEGRAM_CHAT_ID,
  ACTION,
  EXECUTE,
} = process.env;

const CLIENT_NAME = "Alena";
const LOGIN_URL = "https://panel.bilky.es/auth/login";
const WORKSHIFT_URL =
  "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";
const TIMEZONE = "Europe/Madrid";

const required = {
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  ADMIN_TELEGRAM_BOT_TOKEN,
  ADMIN_TELEGRAM_CHAT_ID,
  ACTION,
  EXECUTE,
};

for (const [name, value] of Object.entries(required)) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}

if (!["morning", "evening"].includes(ACTION)) {
  throw new Error(`ACTION must be morning or evening. Got: ${ACTION}`);
}

function getMadridDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const value = (type) =>
    parts.find((part) => part.type === type)?.value;

  return `${value("year")}-${value("month")}-${value("day")}`;
}

const targetDate = getMadridDate();

function displayDate(date) {
  const [y, m, d] = date.split("-");
  return `${d}.${m}.${y}`;
}

function shortFact(time) {
  return time ? time.slice(0, 5) : "--:--";
}

function minutesFromTime(time) {
  if (!time) return null;

  const [h, m] = time
    .slice(0, 5)
    .split(":")
    .map(Number);

  return h * 60 + m;
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;

  return `${h}:${String(m).padStart(2, "0")}`;
}

function dayDuration(morningFact, eveningFact) {
  const start = minutesFromTime(morningFact);
  const end = minutesFromTime(eveningFact);

  if (
    start == null ||
    end == null ||
    end < start
  ) {
    return null;
  }

  return formatDuration(end - start);
}

function log(message) {
  console.log(
    `[${new Date().toISOString()}] ${message}`
  );
}

async function sendTelegramTo(
  botToken,
  chatId,
  message,
  label
) {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `${label} Telegram failed: ${response.status} ${await response.text()}`
    );
  }
}

async function sendTelegram(message) {
  await sendTelegramTo(
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    message,
    "Client"
  );

  await sendTelegramTo(
    ADMIN_TELEGRAM_BOT_TOKEN,
    ADMIN_TELEGRAM_CHAT_ID,
    message,
    "Admin"
  );
}

function extractTime(text) {
  const match = String(text || "").match(
    /\b\d{2}:\d{2}\b/
  );

  return match ? match[0] : null;
}

function extractFactTime(value) {
  if (!value) return null;

  const match = value.match(
    /^\d{2}\/\d{2}\/\d{4}\s+(\d{2}:\d{2}:\d{2})$/
  );

  return match ? match[1] : null;
}

async function locateDayContainer(page, date) {
  const legacy = page.locator(
    `#container_${date}`
  );

  try {
    await legacy.waitFor({
      state: "visible",
      timeout: 8000,
    });

    return {
      locator: legacy,
      mode: "legacy",
    };
  } catch {}

  const [, month, dayRaw] = date.split("-");
  const day = String(Number(dayRaw));
  const year = date.slice(0, 4);

  const monthNames = {
    "01": ["ENERO", "JANUARY"],
    "02": ["FEBRERO", "FEBRUARY"],
    "03": ["MARZO", "MARCH"],
    "04": ["ABRIL", "APRIL"],
    "05": ["MAYO", "MAY"],
    "06": ["JUNIO", "JUNE"],
    "07": ["JULIO", "JULY"],
    "08": ["AGOSTO", "AUGUST"],
    "09": ["SEPTIEMBRE", "SEPTEMBER"],
    "10": ["OCTUBRE", "OCTOBER"],
    "11": ["NOVIEMBRE", "NOVEMBER"],
    "12": ["DICIEMBRE", "DECEMBER"],
  }[month];

  const result = await page.evaluate(
    ({ day, year, monthNames }) => {
      document
        .querySelectorAll(
          '[data-bilky-target-day="true"]'
        )
        .forEach((el) => {
          el.removeAttribute(
            "data-bilky-target-day"
          );
        });

      const shiftLabels = [
        ...document.querySelectorAll("body *"),
      ].filter((el) => {
        const t = (
          el.textContent || ""
        ).trim();

        return (
          t === "Primer turno" ||
          t === "First shift"
        );
      });

      const matches = [];

      for (const label of shiftLabels) {
        let el = label.parentElement;

        for (
          let depth = 0;
          el && depth < 10;
          depth += 1, el = el.parentElement
        ) {
          const text = (
            el.innerText ||
            el.textContent ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();

          const hasYear =
            text.includes(year);

          const hasMonth =
            monthNames.some((m) =>
              text
                .toUpperCase()
                .includes(m)
            );

          const hasDay = new RegExp(
            `(^|\\s)${day}(\\s|$)`
          ).test(text);

          const hasShift =
            /Primer turno|First shift/.test(
              text
            );

          if (
            hasYear &&
            hasMonth &&
            hasDay &&
            hasShift
          ) {
            matches.push(el);
            break;
          }
        }
      }

      const unique = [
        ...new Set(matches),
      ];

      if (unique.length !== 1) {
        return {
          count: unique.length,
          samples: unique
            .slice(0, 3)
            .map((el) =>
              (
                el.innerText || ""
              )
                .replace(/\s+/g, " ")
                .slice(0, 500)
            ),
        };
      }

      unique[0].setAttribute(
        "data-bilky-target-day",
        "true"
      );

      return {
        count: 1,
        samples: [
          (
            unique[0].innerText || ""
          )
            .replace(/\s+/g, " ")
            .slice(0, 500),
        ],
      };
    },
    {
      day,
      year,
      monthNames,
    }
  );

  log(
    `Fallback day-card matches=${result.count}`
  );

  if (result.samples?.length) {
    log(
      `Fallback sample: ${result.samples[0]}`
    );
  }

  if (result.count !== 1) {
    throw new Error(
      `Unable to identify exactly one day card for ${date}; matches=${result.count}`
    );
  }

  const locator = page.locator(
    '[data-bilky-target-day="true"]'
  );

  await locator.waitFor({
    state: "visible",
    timeout: 5000,
  });

  return {
    locator,
    mode: "card",
  };
}

async function readLegacyShiftCell(
  cell
) {
  let planned = null;

  const input = cell
    .locator("input.clockpicker")
    .first();

  if (await input.count()) {
    planned =
      await input.inputValue();
  } else {
    planned = extractTime(
      await cell.innerText()
    );
  }

  let fact = null;
  let factRaw = null;

  const factIcon = cell
    .locator(
      'i.fe-clock[data-original-title]'
    )
    .first();

  if (await factIcon.count()) {
    factRaw =
      await factIcon.getAttribute(
        "data-original-title"
      );

    fact = extractFactTime(
      factRaw
    );
  }

  const clockButton = cell
    .locator("a.clock")
    .first();

  const buttonExists =
    (await clockButton.count()) > 0;

  let buttonEnabled = false;
  let buttonId = null;

  if (buttonExists) {
    const className =
      (await clockButton.getAttribute(
        "class"
      )) || "";

    buttonEnabled =
      !className
        .split(/\s+/)
        .includes("disabled");

    buttonId =
      await clockButton.getAttribute(
        "id"
      );
  }

  return {
    planned,
    fact,
    factRaw,
    buttonExists,
    buttonEnabled,
    buttonId,
  };
}

async function readCardState(
  container
) {
  const text = (
    await container.innerText()
  )
    .replace(/\s+/g, " ")
    .trim();

  const times = [
    ...text.matchAll(
      /\b\d{2}:\d{2}(?::\d{2})?\b/g
    ),
  ].map((m) => m[0]);

  const plannedMorning =
    times.find((t) =>
      t.startsWith("08:00")
    )
      ? "08:00"
      : null;

  const plannedEvening =
    times.find((t) =>
      t.startsWith("16:00")
    )
      ? "16:00"
      : null;

  const factIcons =
    container.locator(
      'i.fe-clock[data-original-title], [data-original-title]'
    );

  const facts = [];

  for (
    let i = 0;
    i < (await factIcons.count());
    i += 1
  ) {
    const raw =
      await factIcons
        .nth(i)
        .getAttribute(
          "data-original-title"
        );

    const fact =
      extractFactTime(raw);

    if (fact) {
      facts.push(fact);
    }
  }

  const ficharButtons =
    container.getByText(
      /^(Fichar|Clock in|Clock out)$/i,
      {
        exact: true,
      }
    );

  const clockButtonCount =
    await ficharButtons.count();

  const clockButton =
    clockButtonCount === 1
      ? ficharButtons.first()
      : null;

  const morningNeedsButton =
    facts.length === 0 &&
    clockButtonCount === 1;

  const eveningNeedsButton =
    facts.length === 1 &&
    clockButtonCount === 1;

  const signed =
    /\bFirmado\b/i.test(text) ||
    /\bSigned\b/i.test(text);

  const pendingSignature =
    /Pendiente de firmar/i.test(
      text
    ) ||
    /Pending signature/i.test(
      text
    );

  const signButton =
    container.getByText(
      /^(Firmar|Sign)$/i,
      {
        exact: true,
      }
    );

  const signAvailable =
    (await signButton.count()) === 1;

  return {
    morning: {
      planned: plannedMorning,
      fact: facts[0] || null,
      buttonExists:
        morningNeedsButton,
      buttonEnabled:
        morningNeedsButton,
      buttonId:
        morningNeedsButton
          ? "text:Fichar"
          : null,
    },

    evening: {
      planned: plannedEvening,
      fact: facts[1] || null,
      buttonExists:
        eveningNeedsButton,
      buttonEnabled:
        eveningNeedsButton,
      buttonId:
        eveningNeedsButton
          ? "text:Fichar"
          : null,
    },

    signed,
    signAvailable,
    pendingSignature,
    clockButton,

    signButton: signAvailable
      ? signButton.first()
      : null,
  };
}

async function readDayState(
  page,
  date
) {
  const located =
    await locateDayContainer(
      page,
      date
    );

  const container =
    located.locator;

  if (
    located.mode === "legacy"
  ) {
    const row = container
      .locator("tr")
      .filter({
        hasText:
          /First shift|Primer turno/,
      })
      .first();

    if (!(await row.count())) {
      throw new Error(
        `Shift row not found for ${date}`
      );
    }

    const shiftCells =
      row.locator(
        "td.hr-container"
      );

    if (
      (await shiftCells.count()) <
      2
    ) {
      throw new Error(
        `Expected morning and evening cells for ${date}`
      );
    }

    const morning =
      await readLegacyShiftCell(
        shiftCells.nth(0)
      );

    const evening =
      await readLegacyShiftCell(
        shiftCells.nth(1)
      );

    const signed =
      (await container
        .locator(".badge-success")
        .filter({
          hasText:
            /Signed|Firmado/,
        })
        .count()) > 0;

    const signAvailable =
      (await container
        .locator("button#sign")
        .count()) > 0;

    const text =
      await container.innerText();

    const pendingSignature =
      /pending signature|pendiente de firmar/i.test(
        text
      );

    return {
      container,
      mode: "legacy",
      morning,
      evening,
      signed,
      signAvailable,
      pendingSignature,
      clockButton: null,

      signButton:
        signAvailable
          ? container
              .locator("button#sign")
              .first()
          : null,
    };
  }

  const card =
    await readCardState(
      container
    );

  return {
    container,
    mode: "card",
    ...card,
  };
}

function printState(state) {
  log("----- DAY STATE -----");

  log(
    `Mode=${state.mode}`
  );

  log(
    `Morning: plan=${
      state.morning.planned ??
      "NONE"
    } fact=${
      state.morning.fact ??
      "NONE"
    } button=${
      state.morning
        .buttonExists
        ? "YES"
        : "NO"
    } enabled=${
      state.morning
        .buttonEnabled
    }`
  );

  log(
    `Evening: plan=${
      state.evening.planned ??
      "NONE"
    } fact=${
      state.evening.fact ??
      "NONE"
    } button=${
      state.evening
        .buttonExists
        ? "YES"
        : "NO"
    } enabled=${
      state.evening
        .buttonEnabled
    }`
  );

  log(
    `Signed=${
      state.signed
    } SignAvailable=${
      state.signAvailable
    } PendingSignature=${
      state.pendingSignature
    }`
  );

  log("---------------------");
}

async function loginAndOpenWorkshift(
  page
) {
  log("Opening Bilky login.");

  await page.goto(
    LOGIN_URL,
    {
      waitUntil:
        "domcontentloaded",
      timeout: 30000,
    }
  );

  const visibleInputs =
    page.locator(
      "input:visible"
    );

  if (
    (await visibleInputs.count()) <
    2
  ) {
    throw new Error(
      "Bilky login fields not found"
    );
  }

  await visibleInputs
    .nth(0)
    .fill(BILKY_NIF);

  await page
    .locator(
      'input[type="password"]'
    )
    .first()
    .fill(BILKY_PASSWORD);

  const submit = page
    .locator(
      'button[type="submit"]'
    )
    .first();

  if (!(await submit.count())) {
    throw new Error(
      "Bilky login button not found"
    );
  }

  await submit.click();

  const deadline =
    Date.now() + 25000;

  while (
    Date.now() < deadline
  ) {
    await page.waitForTimeout(
      1000
    );

    if (
      !page
        .url()
        .includes("/auth/login")
    ) {
      break;
    }
  }

  if (
    page
      .url()
      .includes("/auth/login")
  ) {
    throw new Error(
      "Bilky security verification/login did not clear within 25 seconds"
    );
  }

  log(
    `Login OK. Current URL: ${page.url()}`
  );

  await page.goto(
    WORKSHIFT_URL,
    {
      waitUntil:
        "domcontentloaded",
      timeout: 30000,
    }
  );

  await page.waitForTimeout(
    1500
  );

  log(
    `Workshift opened: ${page.url()}`
  );
}

async function clock(
  page,
  state,
  mode
) {
  const side =
    mode === "morning"
      ? state.morning
      : state.evening;

  const expectedPlan =
    mode === "morning"
      ? "08:00"
      : "16:00";

  if (
    side.planned !==
    expectedPlan
  ) {
    throw new Error(
      `${mode}: unexpected planned time ${side.planned}; expected ${expectedPlan}`
    );
  }

  if (side.fact) {
    log(
      `${mode}: already clocked at ${side.fact}. No duplicate click.`
    );

    return {
      alreadyDone: true,
      fact: side.fact,
    };
  }

  if (
    mode === "evening" &&
    !state.morning.fact
  ) {
    throw new Error(
      "Evening blocked because morning fact is missing"
    );
  }

  let button;

  if (
    state.mode ===
    "legacy"
  ) {
    const row =
      state.container
        .locator("tr")
        .filter({
          hasText:
            /First shift|Primer turno/,
        })
        .first();

    const cells =
      row.locator(
        "td.hr-container"
      );

    const cell =
      mode === "morning"
        ? cells.nth(0)
        : cells.nth(1);

    button = cell
      .locator("a.clock")
      .first();

    if (
      !(await button.count())
    ) {
      throw new Error(
        `${mode}: Clock in/out button does not exist`
      );
    }
  } else {
    if (
      !side.buttonExists ||
      !state.clockButton
    ) {
      throw new Error(
        `${mode}: Fichar button is not uniquely available`
      );
    }

    button =
      state.clockButton;
  }

  log(`CLICK ${mode}`);

  const responsePromise =
    page.waitForResponse(
      (response) =>
        response
          .url()
          .includes(
            "/employee/hour-registration/clock-hour"
          ) &&
        response
          .request()
          .method() === "POST",
      {
        timeout: 20000,
      }
    );

  await button.click();

  const response =
    await responsePromise;

  log(
    `clock-hour HTTP ${response.status()}`
  );

  if (!response.ok()) {
    throw new Error(
      `Bilky clock-hour returned HTTP ${response.status()}`
    );
  }

  await page.waitForTimeout(
    1200
  );

  await page.reload({
    waitUntil:
      "domcontentloaded",
    timeout: 30000,
  });

  await page.waitForTimeout(
    1500
  );

  const newState =
    await readDayState(
      page,
      targetDate
    );

  printState(newState);

  const newSide =
    mode === "morning"
      ? newState.morning
      : newState.evening;

  if (!newSide.fact) {
    throw new Error(
      `${mode}: POST succeeded but factual timestamp was not found after reload`
    );
  }

  log(
    `${mode}: FACT CONFIRMED ${newSide.fact}`
  );

  return {
    alreadyDone: false,
    fact: newSide.fact,
    state: newState,
  };
}

async function signDay(page) {
  let state =
    await readDayState(
      page,
      targetDate
    );

  if (!state.evening.fact) {
    throw new Error(
      "Refusing to sign: evening fact is missing"
    );
  }

  if (state.signed) {
    log(
      "Day already SIGNED/FIRMADO."
    );

    return state;
  }

  if (
    !state.signAvailable ||
    !state.signButton
  ) {
    throw new Error(
      "Evening completed but Sign/Firmar button is unavailable"
    );
  }

  log(
    "Clicking Sign/Firmar."
  );

  await state.signButton.click();

  const confirmButton =
    page.locator(
      ".sweet-alert:visible button.confirm"
    );

  await confirmButton.waitFor({
    state: "visible",
    timeout: 10000,
  });

  const responsePromise =
    page.waitForResponse(
      (response) =>
        response
          .url()
          .includes(
            "/employee/hour-registration/update-registration"
          ) &&
        response
          .request()
          .method() === "POST",
      {
        timeout: 20000,
      }
    );

  log(
    "Confirming Sign/Firmar."
  );

  await confirmButton.click();

  const response =
    await responsePromise;

  log(
    `update-registration HTTP ${response.status()}`
  );

  if (!response.ok()) {
    throw new Error(
      `Bilky Sign returned HTTP ${response.status()}`
    );
  }

  await page.waitForTimeout(
    1200
  );

  await page.reload({
    waitUntil:
      "domcontentloaded",
    timeout: 30000,
  });

  await page.waitForTimeout(
    1500
  );

  state =
    await readDayState(
      page,
      targetDate
    );

  printState(state);

  if (!state.signed) {
    throw new Error(
      "Sign POST succeeded but SIGNED/FIRMADO status was not confirmed after reload"
    );
  }

  log(
    "SIGNED/FIRMADO CONFIRMED."
  );

  return state;
}

async function main() {
  fs.mkdirSync(
    "diagnostics",
    {
      recursive: true,
    }
  );

  log(
    `TARGET_DATE=${targetDate}`
  );

  log(
    `ACTION=${ACTION}`
  );

  log(
    `EXECUTE=${EXECUTE}`
  );

  if (
    EXECUTE !== "true"
  ) {
    throw new Error(
      "Execution blocked by internal kill switch: EXECUTE must equal true"
    );
  }

  const browser =
    await chromium.connectOverCDP(
      `wss://production-ams.browserless.io/stealth?token=${BROWSERLESS_TOKEN}`
    );

  const context =
    browser.contexts()[0] ||
    (await browser.newContext());

  const page =
    context.pages()[0] ||
    (await context.newPage());

  try {
    await loginAndOpenWorkshift(
      page
    );

    let state =
      await readDayState(
        page,
        targetDate
      );

    printState(state);

    if (
      ACTION === "morning"
    ) {
      const result =
        await clock(
          page,
          state,
          "morning"
        );

      await sendTelegram(
        `✅ Bilky for ${CLIENT_NAME} ${displayDate(
          targetDate
        )}: Morning. Fact: ${shortFact(
          result.fact
        )}`
      );

      log(
        "MORNING SUCCESS"
      );

      return;
    }

    const result =
      await clock(
        page,
        state,
        "evening"
      );

    const finalState =
      await signDay(page);

    const duration =
      dayDuration(
        finalState.morning.fact,
        finalState.evening.fact
      );

    if (!duration) {
      throw new Error(
        "Unable to calculate Workday from morning/evening facts"
      );
    }

    await sendTelegram(
      `✅ Bilky for ${CLIENT_NAME} ${displayDate(
        targetDate
      )}: Evening. Fact: ${shortFact(
        result.fact
      )}, Signed. Workday ${duration}`
    );

    log(
      "EVENING SUCCESS"
    );
  } catch (error) {
    console.error(
      `FAILED: ${error.message}`
    );

    try {
      await page.screenshot({
        path:
          "diagnostics/workshift-error.png",
        fullPage: true,
      });
    } catch {}

    const label =
      ACTION === "morning"
        ? "Morning"
        : "Evening";

    try {
      await sendTelegram(
        `❌ Bilky for ${CLIENT_NAME} ${displayDate(
          targetDate
        )}: ${label}. ERROR: ${error.message}`
      );
    } catch (
      telegramError
    ) {
      console.error(
        `Telegram error notification failed: ${telegramError.message}`
      );
    }

    throw error;
  } finally {
    await browser.close();
  }
}

await main();
