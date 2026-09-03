/** Dummy commercial catalogue: ticket types, concessions, offers, cinema extensions. Prices in fils (AED cents). */
import type { OfferBenefit, OfferRules } from "../schema/customer.js";
import type { ModifierGroup } from "../schema/commerce.js";

export type TicketTypeSpec = { code: string; description: string; descriptionAlt: string; area: "0000000002" | "0000000001"; priceInCents: number; isChild?: boolean; loyaltyOnly?: boolean; long?: string };

/** Base price per experience (adult, regular area). Premium view adds +20%. */
export const EXPERIENCE_PRICING: Record<string, { adult: number; child: number; student?: number; senior?: number; premiumView?: boolean; menuTab?: string }> = {
  Standard: { adult: 4500, child: 3500, student: 3800, senior: 3500, premiumView: true },
  MAX: { adult: 6000, child: 4500, student: 5000, premiumView: true },
  IMAX: { adult: 7500, child: 5500, student: 6500, premiumView: true },
  GOLD: { adult: 14500, child: 14500, menuTab: "GOLD Menu" },
  KIDS: { adult: 4500, child: 3500 },
  "4DX": { adult: 8500, child: 7000 },
  THEATRE: { adult: 16500, child: 16500, menuTab: "THEATRE Menu" },
  Premier: { adult: 6500, child: 5000, premiumView: true },
  Premium: { adult: 7500, child: 6000 },
  Couch: { adult: 11000, child: 11000 },
  Outdoor: { adult: 9000, child: 7000 },
  Private: { adult: 25000, child: 25000 },
  Other: { adult: 4500, child: 3500 },
};

export function ticketTypesFor(experience: string): TicketTypeSpec[] {
  const p = EXPERIENCE_PRICING[experience] ?? EXPERIENCE_PRICING.Standard!;
  const ex = experience.toUpperCase();
  const out: TicketTypeSpec[] = [
    { code: "0001", description: `${ex} ADULT`, descriptionAlt: `تذكرة ${experience} بالغ`, area: "0000000002", priceInCents: p.adult },
    { code: "0002", description: `${ex} CHILD (3-12)`, descriptionAlt: `تذكرة ${experience} طفل`, area: "0000000002", priceInCents: p.child, isChild: true },
  ];
  if (p.student) out.push({ code: "0003", description: `${ex} STUDENT`, descriptionAlt: `تذكرة ${experience} طالب`, area: "0000000002", priceInCents: p.student, long: "Valid student ID required at the cinema." });
  if (p.senior) out.push({ code: "0004", description: `${ex} SENIOR (60+)`, descriptionAlt: `تذكرة ${experience} كبار السن`, area: "0000000002", priceInCents: p.senior });
  if (p.premiumView) {
    out.push({ code: "0131", description: `${ex} PREMIUM VIEW ADULT`, descriptionAlt: `${experience} بريميوم فيو بالغ`, area: "0000000001", priceInCents: Math.round(p.adult * 1.2), long: "Premium View seats are further from the screen with extra legroom." });
    out.push({ code: "0132", description: `${ex} PREMIUM VIEW CHILD`, descriptionAlt: `${experience} بريميوم فيو طفل`, area: "0000000001", priceInCents: Math.round(p.child * 1.2), isChild: true });
  }
  out.push({ code: "0090", description: `${ex} SHARE MEMBER`, descriptionAlt: `${experience} عضو شير`, area: "0000000002", priceInCents: Math.round(p.adult * 0.9), loyaltyOnly: true, long: "SHARE members save 10%. Log in to redeem." });
  return out;
}

export type ConcessionSpec = {
  id: string;
  tab: string;
  description: string;
  descriptionAlt: string;
  extended: string;
  price: number;
  dietary: string[];
  allergens?: string[];
  calories?: number;
  isCombo?: boolean;
  children?: { itemId: string; quantity: number }[];
  modifiers?: ModifierGroup[];
  experiences?: string[];
  bestSeller?: boolean;
  image: string;
};

const img = (id: string) => `https://picsum.photos/seed/voxi-${id}/480/320`;
const SIZE: ModifierGroup = { name: "Size", required: true, options: [{ id: "S", name: "Regular", priceInCents: 0 }, { id: "L", name: "Large", priceInCents: 500 }] };
const DRINK: ModifierGroup = { name: "Drink", required: true, options: [{ id: "COKE", name: "Coca-Cola", priceInCents: 0 }, { id: "COKEZ", name: "Coke Zero", priceInCents: 0 }, { id: "SPRITE", name: "Sprite", priceInCents: 0 }, { id: "FANTA", name: "Fanta", priceInCents: 0 }, { id: "WATER", name: "Water", priceInCents: 0 }] };

export const CONCESSIONS: ConcessionSpec[] = [
  { id: "101", tab: "Popcorn", description: "Salted Popcorn", descriptionAlt: "فشار مملح", extended: "Freshly popped, lightly salted.", price: 2800, dietary: ["vegetarian", "vegan", "gluten_free"], calories: 420, modifiers: [SIZE], bestSeller: true, image: img("101") },
  { id: "102", tab: "Popcorn", description: "Sweet Popcorn", descriptionAlt: "فشار حلو", extended: "Caramel-sweet classic.", price: 2800, dietary: ["vegetarian", "gluten_free"], calories: 510, modifiers: [SIZE], image: img("102") },
  { id: "103", tab: "Popcorn", description: "Cheese Popcorn", descriptionAlt: "فشار بالجبنة", extended: "Cheddar-dusted popcorn.", price: 3000, dietary: ["vegetarian", "gluten_free", "contains_dairy"], allergens: ["milk"], calories: 560, modifiers: [SIZE], image: img("103") },
  { id: "104", tab: "Popcorn", description: "Lay's Mango & Hot Spice Popcorn", descriptionAlt: "فشار ليز مانجو وسبايسي", extended: "Limited edition sweet, tangy and spicy premium flavour.", price: 3400, dietary: ["vegetarian"], calories: 540, modifiers: [SIZE], bestSeller: true, image: img("104") },
  { id: "110", tab: "Drinks", description: "Soft Drink", descriptionAlt: "مشروب غازي", extended: "Choose your favourite fountain drink.", price: 1800, dietary: ["vegan", "gluten_free"], calories: 210, modifiers: [SIZE, DRINK], image: img("110") },
  { id: "111", tab: "Drinks", description: "Water 500ml", descriptionAlt: "ماء", extended: "Still water.", price: 800, dietary: ["vegan", "gluten_free"], calories: 0, image: img("111") },
  { id: "112", tab: "Drinks", description: "Iced Latte", descriptionAlt: "لاتيه مثلج", extended: "Double-shot espresso over ice with milk.", price: 2200, dietary: ["vegetarian", "contains_dairy"], allergens: ["milk"], calories: 180, image: img("112") },
  { id: "113", tab: "Drinks", description: "Fresh Orange Juice", descriptionAlt: "عصير برتقال طازج", extended: "Squeezed to order.", price: 2000, dietary: ["vegan", "gluten_free"], calories: 160, image: img("113") },
  { id: "114", tab: "Drinks", description: "Slush", descriptionAlt: "سلاش", extended: "Blue raspberry or strawberry ice slush.", price: 1900, dietary: ["vegan", "gluten_free"], calories: 240, modifiers: [{ name: "Flavour", required: true, options: [{ id: "BLUE", name: "Blue Raspberry", priceInCents: 0 }, { id: "STRAW", name: "Strawberry", priceInCents: 0 }] }], image: img("114") },
  { id: "120", tab: "Hot Food", description: "Messy Chicken Burger", descriptionAlt: "برجر دجاج مسي", extended: "Crispy chicken, slaw and house sauce in a brioche bun.", price: 4200, dietary: [], allergens: ["gluten", "egg", "milk"], calories: 780, bestSeller: true, image: img("120") },
  { id: "121", tab: "Hot Food", description: "Messy Beef Burger", descriptionAlt: "برجر لحم مسي", extended: "Double beef patty, cheese, pickles, smoky sauce.", price: 4500, dietary: [], allergens: ["gluten", "milk"], calories: 860, image: img("121") },
  { id: "122", tab: "Hot Food", description: "Chicken Wrap", descriptionAlt: "راب دجاج", extended: "Grilled chicken, lettuce and garlic sauce in a tortilla.", price: 3600, dietary: [], allergens: ["gluten"], calories: 620, image: img("122") },
  { id: "123", tab: "Hot Food", description: "Chilli Con Carne Wrap", descriptionAlt: "راب تشيلي كون كارني", extended: "Slow-cooked beef chilli, rice and cheese.", price: 3800, dietary: [], allergens: ["gluten", "milk"], calories: 690, image: img("123") },
  { id: "124", tab: "Hot Food", description: "Margherita Pizza (Spider-Man edition)", descriptionAlt: "بيتزا مارغريتا", extended: "Limited-edition Spider-Man pizza with tomato, mozzarella and basil.", price: 4400, dietary: ["vegetarian", "contains_dairy"], allergens: ["gluten", "milk"], calories: 820, image: img("124") },
  { id: "125", tab: "Hot Food", description: "Pepperoni Pizza (Spider-Man edition)", descriptionAlt: "بيتزا بيبروني", extended: "Limited-edition Spider-Man pizza with beef pepperoni.", price: 4800, dietary: [], allergens: ["gluten", "milk"], calories: 910, image: img("125") },
  { id: "126", tab: "Hot Food", description: "Loaded Nachos", descriptionAlt: "ناتشوز محملة", extended: "Tortilla chips, cheese sauce, jalapeños, salsa.", price: 3200, dietary: ["vegetarian", "contains_dairy"], allergens: ["milk"], calories: 640, modifiers: [{ name: "Extras", required: false, options: [{ id: "CHK", name: "Add chicken", priceInCents: 800 }, { id: "GUAC", name: "Add guacamole", priceInCents: 500 }] }], image: img("126") },
  { id: "127", tab: "Hot Food", description: "Falafel Wrap", descriptionAlt: "راب فلافل", extended: "Crispy falafel, hummus, pickles and tahini — plant-based.", price: 3400, dietary: ["vegetarian", "vegan"], allergens: ["gluten", "sesame"], calories: 560, image: img("127") },
  { id: "128", tab: "Hot Food", description: "Chicken Tenders (5 pcs)", descriptionAlt: "تندرز دجاج", extended: "Golden chicken strips with dipping sauce.", price: 3600, dietary: [], allergens: ["gluten", "egg"], calories: 590, image: img("128") },
  { id: "129", tab: "Hot Food", description: "Hot Dog", descriptionAlt: "هوت دوغ", extended: "Beef frank in a soft bun with mustard and ketchup.", price: 2800, dietary: [], allergens: ["gluten"], calories: 480, image: img("129") },
  { id: "130", tab: "Snacks", description: "Sweet Caramel Nachos", descriptionAlt: "ناتشوز كراميل حلوة", extended: "Cinnamon-sugar nachos with Nutella or Lotus dip.", price: 3500, dietary: ["vegetarian", "contains_dairy"], allergens: ["gluten", "milk", "nuts"], calories: 700, modifiers: [{ name: "Dip", required: true, options: [{ id: "NUT", name: "Nutella", priceInCents: 0 }, { id: "LOT", name: "Lotus", priceInCents: 0 }] }], bestSeller: true, image: img("130") },
  { id: "131", tab: "Snacks", description: "M&M's Peanut", descriptionAlt: "إم آند إمز فول سوداني", extended: "Share bag.", price: 1500, dietary: ["vegetarian"], allergens: ["nuts", "milk"], calories: 480, image: img("131") },
  { id: "132", tab: "Snacks", description: "Maltesers", descriptionAlt: "مالتيزرز", extended: "Share bag.", price: 1500, dietary: ["vegetarian"], allergens: ["milk", "gluten"], calories: 440, image: img("132") },
  { id: "133", tab: "Snacks", description: "Crispy Fries", descriptionAlt: "بطاطس مقلية", extended: "Skin-on fries with seasoning.", price: 2000, dietary: ["vegetarian", "vegan", "gluten_free"], calories: 380, image: img("133") },
  { id: "134", tab: "Snacks", description: "Veggie Sticks & Hummus", descriptionAlt: "خضار مع حمص", extended: "Carrot, cucumber and celery with hummus.", price: 2200, dietary: ["vegetarian", "vegan", "gluten_free", "nut_free"], allergens: ["sesame"], calories: 190, image: img("134") },
  { id: "140", tab: "Desserts", description: "Ice Cream Tub", descriptionAlt: "آيس كريم", extended: "Vanilla, chocolate or cookies & cream.", price: 2200, dietary: ["vegetarian", "contains_dairy"], allergens: ["milk"], calories: 320, image: img("140") },
  { id: "141", tab: "Desserts", description: "Chocolate Brownie", descriptionAlt: "براوني شوكولاتة", extended: "Warm brownie with chocolate sauce.", price: 2400, dietary: ["vegetarian"], allergens: ["gluten", "egg", "milk"], calories: 450, image: img("141") },
  { id: "142", tab: "Desserts", description: "Vegan Sorbet", descriptionAlt: "سوربيه نباتي", extended: "Mango sorbet — dairy free.", price: 2200, dietary: ["vegan", "gluten_free", "nut_free"], calories: 180, image: img("142") },
  { id: "150", tab: "Kids", description: "Kids Meal", descriptionAlt: "وجبة أطفال", extended: "Chicken nuggets, small fries, juice and a surprise.", price: 3200, dietary: [], allergens: ["gluten"], calories: 520, image: img("150") },
  { id: "151", tab: "Kids", description: "Kids Popcorn & Juice", descriptionAlt: "فشار وعصير للأطفال", extended: "Small popcorn and apple juice.", price: 2400, dietary: ["vegetarian", "vegan"], calories: 300, image: img("151") },
  { id: "160", tab: "Combos", description: "Classic Combo", descriptionAlt: "كومبو كلاسيك", extended: "Large popcorn + large drink.", price: 4500, dietary: ["vegetarian"], isCombo: true, children: [{ itemId: "101", quantity: 1 }, { itemId: "110", quantity: 1 }], modifiers: [DRINK], bestSeller: true, image: img("160") },
  { id: "161", tab: "Combos", description: "Family Combo", descriptionAlt: "كومبو عائلي", extended: "2 large popcorn + 4 drinks + nachos.", price: 11500, dietary: ["vegetarian"], isCombo: true, children: [{ itemId: "101", quantity: 2 }, { itemId: "110", quantity: 4 }, { itemId: "126", quantity: 1 }], modifiers: [DRINK], image: img("161") },
  { id: "162", tab: "Combos", description: "Summer Combo", descriptionAlt: "كومبو الصيف", extended: "Limited time: Mango & Hot Spice popcorn + slush + sweet nachos.", price: 6900, dietary: ["vegetarian"], isCombo: true, children: [{ itemId: "104", quantity: 1 }, { itemId: "114", quantity: 1 }, { itemId: "130", quantity: 1 }], image: img("162") },
  { id: "163", tab: "Combos", description: "Burger Combo", descriptionAlt: "كومبو برجر", extended: "Messy chicken burger + fries + drink.", price: 6500, dietary: [], isCombo: true, children: [{ itemId: "120", quantity: 1 }, { itemId: "133", quantity: 1 }, { itemId: "110", quantity: 1 }], modifiers: [DRINK], image: img("163") },
  { id: "164", tab: "Combos", description: "Vegan Combo", descriptionAlt: "كومبو نباتي", extended: "Falafel wrap + veggie sticks + water.", price: 5600, dietary: ["vegetarian", "vegan"], isCombo: true, children: [{ itemId: "127", quantity: 1 }, { itemId: "134", quantity: 1 }, { itemId: "111", quantity: 1 }], image: img("164") },
  { id: "170", tab: "GOLD Menu", description: "GOLD Wagyu Sliders", descriptionAlt: "سلايدرز واغيو غولد", extended: "Three wagyu sliders with truffle fries, served to your seat.", price: 8900, dietary: [], allergens: ["gluten", "milk"], calories: 880, experiences: ["GOLD", "THEATRE"], image: img("170") },
  { id: "171", tab: "GOLD Menu", description: "GOLD Truffle Mushroom Pasta", descriptionAlt: "باستا فطر بالكمأة", extended: "Fresh tagliatelle, wild mushrooms, parmesan.", price: 7900, dietary: ["vegetarian", "contains_dairy"], allergens: ["gluten", "milk"], calories: 720, experiences: ["GOLD", "THEATRE"], image: img("171") },
  { id: "172", tab: "GOLD Menu", description: "GOLD Mezze Platter", descriptionAlt: "طبق مقبلات غولد", extended: "Hummus, moutabal, tabbouleh, warm bread — plant-based.", price: 6500, dietary: ["vegetarian", "vegan"], allergens: ["gluten", "sesame"], calories: 540, experiences: ["GOLD", "THEATRE"], image: img("172") },
  { id: "173", tab: "GOLD Menu", description: "GOLD Mocktail", descriptionAlt: "موكتيل غولد", extended: "Passion fruit & mint cooler.", price: 3200, dietary: ["vegan", "gluten_free"], calories: 150, experiences: ["GOLD", "THEATRE"], image: img("173") },
  { id: "180", tab: "Snacks", description: "3D Glasses", descriptionAlt: "نظارات 3D", extended: "Required for 3D sessions if you don't have your own.", price: 300, dietary: [], image: img("180") },
];

export type OfferSpec = { id: string; title: string; titleAlt: string; short: string; shortAlt: string; terms: string; type: "bank" | "promo" | "loyalty" | "member" | "partner"; rules: OfferRules; benefit: OfferBenefit; budget?: number; perMember?: number; howToRedeem: string; priority: number };

export const OFFERS: OfferSpec[] = [
  { id: "BANK-ADCB-BOGO", title: "ADCB – Buy One Get One", titleAlt: "بنك أبوظبي التجاري – اشترِ تذكرة واحصل على أخرى", short: "Buy one ticket, get one free with your ADCB credit card.", shortAlt: "اشترِ تذكرة واحصل على الثانية مجاناً ببطاقة ADCB الائتمانية.", terms: "Valid on Standard and MAX sessions, Sunday–Wednesday. Max 2 free tickets per card per month. Tickets purchased with bank offers are non-refundable.", type: "bank", rules: { experiences: ["Standard", "MAX"], days: [0, 1, 2, 3], bankBins: ["409255", "415732"], bankName: "ADCB", maxTicketsPerRedemption: 4, minTickets: 2 }, benefit: { type: "bogo", buy: 1, get: 1 }, perMember: 2, howToRedeem: "Pay with an eligible ADCB credit card at checkout; the discount is applied automatically.", priority: 10 },
  { id: "BANK-ENBD-BOGO", title: "Emirates NBD – Buy One Get One", titleAlt: "بنك الإمارات دبي الوطني – اشترِ تذكرة واحصل على أخرى", short: "Buy one, get one free on all experiences with Emirates NBD credit cards.", shortAlt: "اشترِ واحدة واحصل على الثانية مجاناً على جميع التجارب ببطاقات الإمارات دبي الوطني.", terms: "Valid every day except public holidays. Excludes Private cinemas. Non-refundable.", type: "bank", rules: { bankBins: ["455533", "521334"], bankName: "Emirates NBD", maxTicketsPerRedemption: 2, minTickets: 2 }, benefit: { type: "bogo", buy: 1, get: 1 }, howToRedeem: "Pay with an Emirates NBD credit card.", priority: 11 },
  { id: "BANK-HSBC-BOGO-FNB", title: "HSBC – BOGO + 25% off F&B", titleAlt: "HSBC – تذكرة مجانية وخصم 25% على المأكولات", short: "Buy one get one free, plus 25% off food and drinks with HSBC credit cards.", shortAlt: "اشترِ تذكرة واحصل على أخرى مجاناً، مع خصم 25% على الطعام والمشروبات.", terms: "Thursday to Saturday. F&B discount applies to items added to the same order.", type: "bank", rules: { days: [4, 5, 6], bankBins: ["424141"], bankName: "HSBC", minTickets: 2 }, benefit: { type: "bogo", buy: 1, get: 1 }, howToRedeem: "Pay with an HSBC credit card.", priority: 12 },
  { id: "BANK-CBD-50", title: "Commercial Bank of Dubai – 50% off", titleAlt: "بنك دبي التجاري – خصم 50%", short: "50% off movie tickets with CBD credit cards.", shortAlt: "خصم 50% على تذاكر السينما ببطاقات بنك دبي التجاري.", terms: "Up to 4 tickets per transaction. Standard and Premier only.", type: "bank", rules: { experiences: ["Standard", "Premier"], bankBins: ["437745"], bankName: "CBD", maxTicketsPerRedemption: 4 }, benefit: { type: "percent_off", percent: 50, appliesTo: "tickets" }, howToRedeem: "Pay with a CBD credit card.", priority: 13 },
  { id: "BANK-MASHREQ-50", title: "Mashreq – 50% off", titleAlt: "المشرق – خصم 50%", short: "50% off movie tickets with selected Mashreq credit cards.", shortAlt: "خصم 50% على التذاكر ببطاقات المشرق المختارة.", terms: "Valid Sunday–Thursday. Max 2 tickets.", type: "bank", rules: { days: [0, 1, 2, 3, 4], bankBins: ["472937"], bankName: "Mashreq", maxTicketsPerRedemption: 2 }, benefit: { type: "percent_off", percent: 50, appliesTo: "tickets" }, howToRedeem: "Pay with a Mashreq credit card.", priority: 14 },
  { id: "VOX-JUNIOR-CLUB", title: "Junior Club – AED 25 tickets", titleAlt: "نادي الصغار – تذاكر بـ 25 درهماً", short: "AED 25 tickets for re-releases at VOX KIDS every Friday, Saturday & Sunday.", shortAlt: "تذاكر بـ 25 درهماً لعروض الأطفال المعادة في VOX KIDS كل جمعة وسبت وأحد.", terms: "KIDS experience only, weekends.", type: "promo", rules: { experiences: ["KIDS"], days: [5, 6, 0] }, benefit: { type: "fixed_price_cents", priceCents: 2500, appliesTo: "tickets" }, howToRedeem: "Select a KIDS weekend session; the price is applied automatically.", priority: 20 },
  { id: "PROMO-MOVIEMONDAY", title: "Movie Monday – 30% off", titleAlt: "الاثنين السينمائي – خصم 30%", short: "30% off Standard tickets every Monday with code MONDAY30.", shortAlt: "خصم 30% على التذاكر العادية كل اثنين برمز MONDAY30.", terms: "Online only. Not combinable with bank offers.", type: "promo", rules: { experiences: ["Standard"], days: [1], promoCode: "MONDAY30" }, benefit: { type: "percent_off", percent: 30, appliesTo: "tickets" }, budget: 500, howToRedeem: "Enter promo code MONDAY30 at checkout.", priority: 21 },
  { id: "PROMO-FNB-COMBO10", title: "AED 10 off any combo", titleAlt: "خصم 10 دراهم على أي كومبو", short: "AED 10 off any combo when added to your ticket order.", shortAlt: "خصم 10 دراهم على أي كومبو عند إضافته لطلب التذاكر.", terms: "One per order.", type: "promo", rules: {}, benefit: { type: "amount_off_cents", amountCents: 1000, appliesTo: "concessions" }, howToRedeem: "Add a combo to your order; the discount applies automatically.", priority: 30 },
  { id: "SHARE-MEMBER-10", title: "SHARE members save 10%", titleAlt: "أعضاء شير يوفرون 10%", short: "Logged-in SHARE members get 10% off tickets and earn Share Points on every purchase.", shortAlt: "أعضاء شير المسجلون يحصلون على خصم 10% ويكسبون نقاط شير مع كل عملية شراء.", terms: "Members only.", type: "member", rules: { membersOnly: true }, benefit: { type: "percent_off", percent: 10, appliesTo: "tickets" }, howToRedeem: "Log in with your SHARE account before paying.", priority: 40 },
  { id: "SHARE-DOUBLE-POINTS", title: "Double Share Points on GOLD", titleAlt: "نقاط شير مضاعفة على غولد", short: "Earn 2x Share Points on GOLD and THEATRE bookings this month.", shortAlt: "اكسب نقاط شير مضاعفة على حجوزات غولد وثياتر هذا الشهر.", terms: "Members only. Gold and Platinum tiers.", type: "loyalty", rules: { membersOnly: true, experiences: ["GOLD", "THEATRE"], tiers: ["Gold", "Platinum"] }, benefit: { type: "points_multiplier", multiplier: 2 }, howToRedeem: "Automatic for eligible members.", priority: 41 },
  { id: "PROMO-3DGLASSES", title: "Free 3D glasses", titleAlt: "نظارات 3D مجانية", short: "Free 3D glasses with any IMAX ticket.", shortAlt: "نظارات 3D مجانية مع أي تذكرة آيماكس.", terms: "IMAX 3D sessions only.", type: "promo", rules: { experiences: ["IMAX"] }, benefit: { type: "free_item", itemId: "180" }, howToRedeem: "Automatic.", priority: 50 },
];

/** Per-cinema extensions (in-mall directions, parking, hours, accessibility). Dummy where not on the website. */
export const CINEMA_EXTRAS: Record<string, { directions: string; directionsAlt: string; parking: string; accessibility: string; hours?: [string, string] }> = {
  "0002": { directions: "Take the escalators to Level 2 next to Ski Dubai's viewing gallery; VOX is opposite the Kempinski entrance. From the Carrefour side, follow the signs to 'Cinema'.", directionsAlt: "اصعد بالسلالم المتحركة إلى الطابق الثاني بجوار سكي دبي؛ فوكس مقابل مدخل كمبينسكي.", parking: "Park in the East car park (Level 2) – it is the closest to the cinema entrance. Valet is available at the Kempinski entrance.", accessibility: "Step-free access via lifts by the East car park; wheelchair seats in every screen; accessible restrooms next to the ticket desk." },
  "0001": { directions: "VOX is on Level 2 above the food court. Take the lifts near Carrefour or the escalators from the central atrium.", directionsAlt: "فوكس في الطابق الثاني فوق منطقة المطاعم. استخدم المصاعد قرب كارفور.", parking: "Level 2 parking (P2) has a direct walkway to the cinema.", accessibility: "Lift access from all parking levels; wheelchair-accessible seating; hearing-loop available at GOLD." },
  "0005": { directions: "Located on Level 2 at the Ghurair end of the mall next to Magic Planet.", directionsAlt: "في الطابق الثاني بجوار ماجيك بلانيت.", parking: "Use the P2 Blue car park entrance from Tripoli Street.", accessibility: "Step-free access; wheelchair seats available in all screens." },
  "0046": { directions: "VOX is on the 4th level of The Galleria, above the luxury wing. Take the lifts from the ADGM Square entrance.", directionsAlt: "فوكس في الطابق الرابع من الغاليريا فوق الجناح الفاخر.", parking: "Basement parking B2 is closest to the cinema lifts; 3 hours free with validation.", accessibility: "Fully step-free; accessible seating in IMAX, THEATRE and KIDS." },
  "0012": { directions: "Level 2, next to the food court. From the main entrance, take the escalators up twice and turn right.", directionsAlt: "الطابق الثاني بجوار منطقة المطاعم.", parking: "North car park Level 2 – closest to the cinema entrance.", accessibility: "Step-free access; wheelchair seating; companion seats available." },
  "0049": { directions: "VOX is on Level 3 (top floor) of Nakheel Mall. Take the panoramic lifts from the Palm Monorail entrance.", directionsAlt: "فوكس في الطابق الثالث من نخيل مول.", parking: "Level 3 parking connects directly to the cinema foyer.", accessibility: "Step-free access; wheelchair seats in every screen." },
};

export const DEFAULT_EXTRA = (cinemaLocation: string, parking: string) => ({
  directions: cinemaLocation ? `The cinema is located on ${cinemaLocation.replace(/^Located on\s*/i, "")}. Follow the 'VOX Cinemas' signs from the main atrium or ask at the mall information desk.` : "Follow the 'VOX Cinemas' signs from the main atrium or ask at the mall information desk.",
  directionsAlt: cinemaLocation ? `تقع السينما في ${cinemaLocation}. اتبع لافتات فوكس سينما من البهو الرئيسي.` : "اتبع لافتات فوكس سينما من البهو الرئيسي.",
  parking: parking ? `Nearest parking: ${parking}.` : "Use the mall car park closest to the cinema entrance; parking is free for cinema guests.",
  accessibility: "Step-free access via mall lifts; wheelchair-accessible seating available in every screen (please ask staff for assistance); accessible restrooms nearby.",
});

export const AGE_RULES = [
  { rating: "G", minAge: 0, text: "Suitable for all ages." },
  { rating: "PG", minAge: 0, text: "Parental guidance advised. Some material may not be suitable for children." },
  { rating: "PG13", minAge: 0, text: "Guests aged 13 and under may attend but must be accompanied by someone aged 13 or older." },
  { rating: "PG15", minAge: 0, text: "Guests aged 15 and under may attend but must be accompanied by someone aged 15 or older." },
  { rating: "15+", minAge: 15, text: "No persons under 15 will be admitted. ID required. Infants not allowed." },
  { rating: "18+", minAge: 18, text: "No persons under 18 will be admitted. ID required. Infants not allowed." },
  { rating: "18TC", minAge: 18, text: "Provisionally rated 18+ pending final classification. Tickets are non-refundable." },
  { rating: "21+", minAge: 21, text: "No persons under 21 will be admitted. ID required." },
];

export const EXPERIENCE_AGE_RULES: Record<string, string> = {
  GOLD: "GOLD is an adults-first experience: guests must be 18+ except at Mall of the Emirates, City Centre Mirdif and Yas Mall where children 8+ are welcome with an adult.",
  THEATRE: "THEATRE welcomes guests 18+ only.",
  KIDS: "KIDS screens are designed for children; adults must be accompanied by a child (booster seats available).",
  "4DX": "4DX: minimum height 100 cm; not recommended for pregnant guests or guests with heart or back conditions.",
  Private: "Private cinemas: booker must be 21+.",
};
