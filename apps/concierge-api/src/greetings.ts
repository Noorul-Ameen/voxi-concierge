/** Server-owned greeting copy. Only pass a name read from the authenticated account. */

export type GreetingContext = {
  /** Local hour (0–23) at the cinema; picks morning/afternoon/evening wording. */
  hour?: number;
  /** A booking the guest has later today; mentioned in some variants. */
  todayBooking?: { filmTitle: string; timeEn: string; timeAr: string } | null;
};

type Line = { en: string; ar: string };

const NAMED_OPENERS: ((name: string, tod: Line) => Line)[] = [
  (n) => ({ en: `Welcome back, ${n}!`, ar: `أهلاً بعودتك يا ${n}!` }),
  (n) => ({ en: `Good to see you again, ${n}!`, ar: `سعدت بعودتك يا ${n}!` }),
  (n) => ({ en: `Hi ${n}, lovely to have you back.`, ar: `مرحباً يا ${n}، يسعدني أن أراك مجدداً.` }),
  (n) => ({ en: `Hi ${n}, welcome back to VOX.`, ar: `أهلاً يا ${n}، نورت فوكس من جديد.` }),
  (n, tod) => ({ en: `${tod.en}, ${n}!`, ar: `${tod.ar} يا ${n}!` }),
  (n) => ({
    en: `Hello again, ${n} — great to have you here.`,
    ar: `أهلاً مجدداً يا ${n}، يسعدنا وجودك معنا.`,
  }),
  (n) => ({ en: `${n}, welcome back to the movies!`, ar: `${n}، أهلاً بعودتك إلى عالم السينما!` }),
  (n) => ({ en: `Nice to see you, ${n}.`, ar: `سررت برؤيتك يا ${n}.` }),
  (n, tod) => ({ en: `${tod.en} and welcome back, ${n}.`, ar: `${tod.ar} وأهلاً بعودتك يا ${n}.` }),
  (n) => ({ en: `Welcome back to VOX Cinemas, ${n}.`, ar: `أهلاً بعودتك إلى فوكس سينما يا ${n}.` }),
];

const NAMED_QUESTIONS: Line[] = [
  { en: "What are you in the mood to watch?", ar: "ما الفيلم الذي نختاره اليوم؟" },
  { en: "How can I help you today?", ar: "كيف أساعدك اليوم؟" },
  { en: "What can I help you plan today?", ar: "بماذا أساعدك اليوم؟" },
  { en: "What's on your mind today?", ar: "كيف نجعل زيارتك للسينما أجمل اليوم؟" },
  { en: "Shall we find you something great to watch?", ar: "هل نبحث لك عن فيلم رائع؟" },
  {
    en: "Looking for a film, or is there a booking I can help with?",
    ar: "هل تبحث عن فيلم، أم هناك حجز أساعدك فيه؟",
  },
  { en: "Where shall we start today?", ar: "من أين نبدأ اليوم؟" },
];

const GUEST_OPENERS: ((tod: Line) => Line)[] = [
  () => ({ en: "Hi, welcome to VOX Cinemas.", ar: "أهلاً بك في فوكس سينما." }),
  (tod) => ({ en: `${tod.en}, welcome to VOX Cinemas.`, ar: `${tod.ar}، أهلاً بك في فوكس سينما.` }),
  () => ({ en: "Hello and welcome to VOX Cinemas!", ar: "مرحباً بك في فوكس سينما!" }),
  () => ({
    en: "Welcome to VOX Cinemas — great to have you here.",
    ar: "أهلاً بك في فوكس سينما، يسعدنا وجودك معنا.",
  }),
  () => ({ en: "Hi there, welcome to VOX.", ar: "أهلاً بك في فوكس." }),
  (tod) => ({ en: `${tod.en}! Welcome to VOX Cinemas.`, ar: `${tod.ar}! أهلاً بك في فوكس سينما.` }),
];

const GUEST_QUESTIONS: Line[] = [
  { en: "What are you in the mood to watch?", ar: "ما نوع الأفلام التي تود مشاهدتها اليوم؟" },
  { en: "How can I help you today?", ar: "كيف أساعدك اليوم؟" },
  { en: "Shall we find you something great to watch?", ar: "هل نبحث لك عن فيلم رائع؟" },
  {
    en: "Looking for a film, showtimes, or help with a booking?",
    ar: "هل تبحث عن فيلم أو مواعيد عرض، أم تحتاج مساعدة في حجز؟",
  },
  { en: "Where shall we start?", ar: "من أين نبدأ؟" },
];

/** Distinct greetings before the rotation repeats (members / guests). */
export const NAMED_GREETING_COUNT = NAMED_OPENERS.length * NAMED_QUESTIONS.length;
export const GUEST_GREETING_COUNT = GUEST_OPENERS.length * GUEST_QUESTIONS.length;

function timeOfDay(hour: number | undefined): Line {
  if (hour == null || !Number.isFinite(hour)) return { en: "Hello", ar: "أهلاً" };
  if (hour < 12) return { en: "Good morning", ar: "صباح الخير" };
  if (hour < 17) return { en: "Good afternoon", ar: "مساء الخير" };
  return { en: "Good evening", ar: "مساء الخير" };
}

function safeVariant(variant: number, size: number): number {
  return Number.isSafeInteger(variant) && variant >= 0 ? variant % size : 0;
}

/** Deterministic: the same (name, variant, context) always gives the same copy. Callers rotate the variant. */
export function greetings(firstName?: string | null, variant = 0, ctx: GreetingContext = {}) {
  const name = (firstName ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const tod = timeOfDay(ctx.hour);
  if (!name) {
    const v = safeVariant(variant, GUEST_GREETING_COUNT);
    const opener = GUEST_OPENERS[v % GUEST_OPENERS.length]!(tod);
    const question = GUEST_QUESTIONS[(v + Math.floor(v / GUEST_OPENERS.length)) % GUEST_QUESTIONS.length]!;
    return {
      firstName: "",
      welcomeEn: opener.en,
      welcomeAr: opener.ar,
      greetingEn: `${opener.en} ${question.en}`,
      greetingAr: `${opener.ar} ${question.ar}`,
    };
  }
  const v = safeVariant(variant, NAMED_GREETING_COUNT);
  const opener = NAMED_OPENERS[v % NAMED_OPENERS.length]!(name, tod);
  const question = NAMED_QUESTIONS[(v + Math.floor(v / NAMED_OPENERS.length)) % NAMED_QUESTIONS.length]!;
  const booking = ctx.todayBooking;
  const film = booking?.filmTitle?.trim();
  // Every third visit with a booking today mentions it instead of asking what to watch.
  if (film && booking?.timeEn && booking.timeAr && v % 3 === 0) {
    return {
      firstName: name,
      welcomeEn: opener.en,
      welcomeAr: opener.ar,
      greetingEn: `${opener.en} All set for ${film} at ${booking.timeEn} today? Let me know if you need anything for it.`,
      greetingAr: `${opener.ar} كل شيء جاهز لفيلم ${film} الساعة ${booking.timeAr} اليوم؟ أخبرني إن احتجت أي شيء له.`,
    };
  }
  return {
    firstName: name,
    welcomeEn: opener.en,
    welcomeAr: opener.ar,
    greetingEn: `${opener.en} ${question.en}`,
    greetingAr: `${opener.ar} ${question.ar}`,
  };
}

/**
 * Picks the next rotation index that was not used in the guest's recent visits.
 * `recent` holds the most recent indices first; `preferred` is the client's own counter (guests).
 */
export function nextGreetingVariant(recent: number[], size: number, preferred?: number): number {
  const avoid = new Set(recent.filter((n) => Number.isSafeInteger(n) && n >= 0).slice(0, 5));
  const start = Number.isSafeInteger(preferred) && preferred! >= 0 ? preferred! : (recent[0] ?? -1) + 1;
  for (let i = 0; i < size; i++) {
    const candidate = (start + i) % size;
    if (!avoid.has(candidate)) return candidate;
  }
  return start % size;
}
