import type { ConnectionDetails, Lang, Session } from "./api";

let fallbackVariant = 0;
/** Only an anonymous counter is persisted; no customer name, account ID or credentials. */
export function nextWelcomeVariant(storage?: Pick<Storage, "getItem" | "setItem">): number {
  try {
    const target = storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : undefined);
    if (target) {
      const value = Number(target.getItem("voxi.welcome.variant") ?? 0);
      const variant = Number.isSafeInteger(value) && value >= 0 ? value : 0;
      target.setItem("voxi.welcome.variant", String((variant + 1) % 1000000));
      return variant;
    }
  } catch { /* Restricted storage still allows varied greetings during this page visit. */ }
  return fallbackVariant++;
}

export type ConnectionSnapshot = { attempt: number; epoch: number; token?: string; conversationId?: string };
export function isCurrentConnection(expected: ConnectionSnapshot, current: ConnectionSnapshot & { busy: boolean }) {
  return !current.busy && expected.attempt === current.attempt && expected.epoch === current.epoch
    && (expected.token === undefined || (expected.token === current.token && expected.conversationId === current.conversationId));
}

/** Prefer freshly authenticated server copy; a mixed-version server safely receives a generic welcome. */
export function connectionVariables(session: Session, connection: ConnectionDetails, language: Lang, continuation?: "active" | "expired") {
  const verified = connection.dynamicVariables;
  const named = connection.isLoggedIn === true && typeof verified?.firstName === "string" && !!verified.firstName.trim();
  const welcomeEn = named && verified.welcomeEn ? verified.welcomeEn : "Hi, welcome to VOX Cinemas.";
  const welcomeAr = named && verified.welcomeAr ? verified.welcomeAr : "أهلاً بك في فوكس سينما.";
  return {
    ...(verified ?? {}),
    conversationId: session.conversationId, language, channel: "web",
    firstName: named ? verified.firstName : "",
    customerId: connection.isLoggedIn === true ? verified?.customerId ?? "" : "",
    memberId: connection.isLoggedIn === true ? verified?.memberId ?? "" : "",
    welcomeEn, welcomeAr,
    greetingEn: continuation
      ? `${named ? welcomeEn : "Welcome back."} ${continuation === "expired" ? "Your choices are saved—shall I check and hold seats again?" : "Shall we pick up your booking?"}`
      : named && verified.greetingEn ? verified.greetingEn : "Hi, welcome to VOX Cinemas. What are you in the mood to watch?",
    greetingAr: continuation
      ? `${named ? welcomeAr : "أهلاً بعودتك."} ${continuation === "expired" ? "اختياراتك محفوظة، هل أتحقق وأحجز المقاعد مجدداً؟" : "هل نكمل حجزك؟"}`
      : named && verified.greetingAr ? verified.greetingAr : "أهلاً بك في فوكس سينما. ما نوع الأفلام التي تود مشاهدتها اليوم؟",
  };
}
