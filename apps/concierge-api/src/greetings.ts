/** Server-owned greeting copy. Only pass a name read from the authenticated account. */
export function greetings(firstName?: string | null, variant = 0) {
  const name = (firstName ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const choices = [
    {
      en: `Welcome back, ${name}!`,
      ar: `أهلاً بعودتك يا ${name}!`,
      questionEn: "What are you in the mood to watch?",
      questionAr: "ما الفيلم الذي نختاره اليوم؟",
    },
    {
      en: `Good to see you again, ${name}!`,
      ar: `سعدت بعودتك يا ${name}!`,
      questionEn: "How can I help you today?",
      questionAr: "كيف أساعدك اليوم؟",
    },
    {
      en: `Hi ${name}, lovely to have you back.`,
      ar: `مرحباً يا ${name}، يسعدني أن أراك مجدداً.`,
      questionEn: "What can I help you plan today?",
      questionAr: "بماذا أساعدك اليوم؟",
    },
    {
      en: `Hi ${name}, welcome back to VOX.`,
      ar: `أهلاً يا ${name}، نورت فوكس من جديد.`,
      questionEn: "What's on your mind today?",
      questionAr: "كيف نجعل زيارتك للسينما أجمل اليوم؟",
    },
  ];
  const choice = choices[Number.isSafeInteger(variant) && variant >= 0 ? variant % choices.length : 0]!;
  const welcomeEn = name ? choice.en : "Hi, welcome to VOX Cinemas.";
  const welcomeAr = name ? choice.ar : "أهلاً بك في فوكس سينما.";
  return {
    firstName: name,
    welcomeEn,
    welcomeAr,
    greetingEn: `${welcomeEn} ${name ? choice.questionEn : "What are you in the mood to watch?"}`,
    greetingAr: `${welcomeAr} ${name ? choice.questionAr : "ما نوع الأفلام التي تود مشاهدتها اليوم؟"}`,
  };
}
