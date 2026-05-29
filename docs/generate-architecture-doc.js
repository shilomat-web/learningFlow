// docs/generate-architecture-doc.js
// מחולל מסמך ארכיטקטורה (DOCX) עבור studyFlow — עברית, יישור לימין (RTL).
//
// הרצה:   node docs/generate-architecture-doc.js
// פלט:    docs/studyFlow-ארכיטקטורה.docx
//
// כל התוכן מרוכז במבנה הנתונים DOC שלמטה כדי שעדכון המסמך יהיה פשוט:
// משנים טקסט במקום אחד ומריצים שוב את הסקריפט. זהו ה"רענון" של התיעוד.

const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, BorderStyle, Table, TableRow, TableCell,
  WidthType, ShadingType, TableLayoutType,
} = require('docx');

const FONT = 'Arial';            // גופן עברי זמין כמעט בכל מחשב
const ACCENT = '2E8B57';         // ירוק (theme color של האפליקציה)
const GREY = '555555';

// ── עוזרים ליצירת פסקאות RTL ─────────────────────────────────
function run(text, opts = {}) {
  return new TextRun({
    text,
    font: FONT,
    rightToLeft: true,
    size: opts.size || 22,        // half-points → 22 = 11pt
    bold: !!opts.bold,
    italics: !!opts.italics,
    color: opts.color,
  });
}

function para(text, opts = {}) {
  return new Paragraph({
    bidirectional: true,
    alignment: opts.align || AlignmentType.RIGHT,
    spacing: { after: opts.after == null ? 120 : opts.after, line: 300 },
    children: Array.isArray(text) ? text : [run(text, opts)],
  });
}

function title(text) {
  return new Paragraph({
    bidirectional: true,
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [new TextRun({ text, font: FONT, rightToLeft: true, bold: true, size: 56, color: ACCENT })],
  });
}

function subtitle(text) {
  return new Paragraph({
    bidirectional: true,
    alignment: AlignmentType.CENTER,
    spacing: { after: 400 },
    children: [new TextRun({ text, font: FONT, rightToLeft: true, size: 26, color: GREY })],
  });
}

function h1(text) {
  return new Paragraph({
    bidirectional: true,
    alignment: AlignmentType.RIGHT,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 160 },
    border: { bottom: { color: ACCENT, style: BorderStyle.SINGLE, size: 12, space: 4 } },
    children: [new TextRun({ text, font: FONT, rightToLeft: true, bold: true, size: 34, color: ACCENT })],
  });
}

function h2(text) {
  return new Paragraph({
    bidirectional: true,
    alignment: AlignmentType.RIGHT,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 100 },
    children: [new TextRun({ text, font: FONT, rightToLeft: true, bold: true, size: 26, color: '333333' })],
  });
}

function bullet(text, level = 0) {
  return new Paragraph({
    bidirectional: true,
    alignment: AlignmentType.RIGHT,
    bullet: { level },
    spacing: { after: 60, line: 300 },
    children: Array.isArray(text) ? text : [run(text)],
  });
}

// פסקת "תווית: ערך" — התווית מודגשת
function kv(label, value) {
  return bullet([run(label + ': ', { bold: true }), run(value)]);
}

// ── טבלה RTL ─────────────────────────────────────────────────
function cell(text, opts = {}) {
  return new TableCell({
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    shading: opts.header ? { type: ShadingType.CLEAR, fill: ACCENT, color: 'auto' } : undefined,
    children: [new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.RIGHT,
      spacing: { after: 0 },
      children: [new TextRun({
        text,
        font: FONT,
        rightToLeft: true,
        size: 20,
        bold: !!opts.header,
        color: opts.header ? 'FFFFFF' : '000000',
      })],
    })],
  });
}

function table(headers, rows) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(h => cell(h, { header: true })),
  });
  const bodyRows = rows.map(r => new TableRow({ children: r.map(c => cell(c)) }));
  return new Table({
    visuallyRightToLeft: true,
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    rows: [headerRow, ...bodyRows],
  });
}

function spacer() {
  return new Paragraph({ spacing: { after: 120 }, children: [run('')] });
}

// ─────────────────────────────────────────────────────────────
// תוכן המסמך
// ─────────────────────────────────────────────────────────────
const children = [];
const add = (...items) => items.forEach(i => children.push(i));

// שער
add(
  title('studyFlow'),
  subtitle('מסמך ארכיטקטורה — סקירה לא-טכנית'),
  para([
    run('עודכן לאחרונה: ', { bold: true, color: GREY }),
    run(new Date().toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' }), { color: GREY }),
  ], { align: AlignmentType.CENTER }),
);

// 1. תקציר מנהלים
add(
  h1('1. תקציר מנהלים'),
  para('studyFlow היא אפליקציית רשת לניהול לימודים אישי, המיועדת לתלמידים ולסטודנטים. היא עוזרת לעקוב אחר נושאי לימוד, משימות, מבחנים וזמן לימוד — והכול במקום אחד, בעברית מלאה ובכיוון מימין לשמאל.'),
  para('האפליקציה בנויה כ"אפליקציית רשת מתקדמת" (PWA), כלומר ניתן להתקין אותה על הטלפון או המחשב כמו אפליקציה רגילה, והיא ממשיכה לעבוד גם ללא חיבור לאינטרנט. כל הנתונים של המשתמש נשמרים בענן ומסונכרנים אוטומטית בין המכשירים.'),
  para('בנוסף לניהול הנתונים, האפליקציה כוללת עוזר לימודים מבוסס בינה מלאכותית (AI), שיכול לענות בעברית על שאלות לגבי ההתקדמות האישית — למשל "כמה זמן למדתי השבוע?" או "אילו מבחנים מתקרבים?".'),
  h2('עקרונות מנחים'),
  bullet('פשטות: ממשק נקי בעברית, ללא עומס מיותר.'),
  bullet('אמינות: השמירה "עמידה לכשלים" — גם אם החיבור נופל, השינויים נשמרים מקומית ועולים לשרת ברגע שהחיבור חוזר.'),
  bullet('ניידות: עובדת בדפדפן, על הנייד ועל המחשב, גם במצב לא-מקוון.'),
);

// 2. סקירת ארכיטקטורה
add(
  h1('2. סקירת הארכיטקטורה'),
  para('המערכת בנויה משלושה רכיבים עיקריים שמדברים זה עם זה:'),
  h2('א. צד הלקוח (מה שהמשתמש רואה)'),
  para('קובץ יחיד בשם index.html מכיל את כל האפליקציה — העיצוב, המבנה והלוגיקה. הוא כתוב ב-JavaScript "טהור" (ללא ספריות כבדות כמו React), מה שהופך אותו לקל, מהיר ופשוט לתחזוקה. זהו "אתר עמוד יחיד" (SPA): המעבר בין המסכים השונים קורה מיידית בלי טעינה מחדש של הדף.'),
  h2('ב. צד השרת (המוח מאחורי הקלעים)'),
  para('פונקציית שרת אחת בשם api/chat.js רצה על פלטפורמת Vercel. היא אחראית על כל מה שדורש סודיות או חיבור למערכות חיצוניות: רישום והתחברות משתמשים, שמירה וטעינה של הנתונים, וגישה לעוזר ה-AI. הפונקציה כתובה ללא תלות בספריות חיצוניות — היא פונה ישירות לשירותים דרך בקשות רשת רגילות.'),
  h2('ג. מסד הנתונים והשירותים החיצוניים'),
  bullet([run('Supabase — ', { bold: true }), run('מסד הנתונים בענן (מבוסס Postgres) ושירות ניהול המשתמשים (הרשמה, התחברות, סיסמאות).')]),
  bullet([run('Groq — ', { bold: true }), run('שירות הבינה המלאכותית המפעיל את עוזר הלימודים (מודל בשם llama-3.3-70b).')]),
  bullet([run('Vercel — ', { bold: true }), run('פלטפורמת האירוח שמגישה את האפליקציה למשתמשים ומריצה את פונקציית השרת.')]),
  spacer(),
  para('זרימה כללית בתמונה אחת:', { bold: true }),
  para('המשתמש ← האפליקציה בדפדפן (index.html) ← פונקציית השרת (api/chat.js) ← מסד הנתונים (Supabase) / הבינה המלאכותית (Groq).', { color: GREY, italics: true }),
);

// טבלת טכנולוגיות
add(
  h2('טבלת רכיבים מהירה'),
  table(
    ['רכיב', 'טכנולוגיה', 'תפקיד'],
    [
      ['ממשק משתמש', 'HTML / CSS / JavaScript', 'כל המסכים והאינטראקציה'],
      ['שרת', 'Vercel Serverless Function', 'התחברות, שמירה, AI'],
      ['מסד נתונים', 'Supabase (Postgres)', 'אחסון נתוני המשתמשים'],
      ['ניהול משתמשים', 'Supabase Auth', 'הרשמה והתחברות מאובטחת'],
      ['בינה מלאכותית', 'Groq (Llama 3.3)', 'עוזר לימודים בעברית'],
      ['אירוח', 'Vercel', 'הגשת האפליקציה לאינטרנט'],
      ['מצב לא-מקוון', 'Service Worker (sw.js)', 'עבודה ללא אינטרנט והתקנה'],
    ],
  ),
);

// 3. מבנה התיקיות והקבצים
add(
  h1('3. מבנה הקבצים בפרויקט'),
  para('הפרויקט קטן ומסודר. אלו הקבצים המרכזיים ותפקידם:'),
  kv('index.html', 'לב האפליקציה — כל הממשק והלוגיקה בקובץ אחד (כ-5,200 שורות).'),
  kv('api/chat.js', 'פונקציית השרת היחידה — מטפלת בהתחברות, שמירה/טעינה של נתונים ובעוזר ה-AI.'),
  kv('sw.js', '"Service Worker" — מאפשר עבודה ללא אינטרנט, התקנה כאפליקציה, וניהול זיכרון מטמון.'),
  kv('manifest.json', 'הגדרות ההתקנה כאפליקציה (שם, אייקון, צבעים, קיצורי דרך).'),
  kv('vercel.json', 'הגדרות האירוח (כותרות אבטחה ומדיניות מטמון).'),
  kv('logo.png', 'הלוגו והאייקון של האפליקציה.'),
  kv('package.json', 'רשימת התלויות של הפרויקט (ספריות עזר).'),
  kv('docs/', 'תיקיית התיעוד — כאן נמצא מסמך זה והסקריפט שמייצר אותו.'),
);

// 4. מודל הנתונים
add(
  h1('4. מודל הנתונים'),
  para('כל הנתונים של משתמש נשמרים יחד כ"חבילה" אחת (אובייקט JSON) בשורה אחת במסד הנתונים. הגישה הזו פשוטה ואמינה: טוענים הכול בבת אחת ושומרים הכול בבת אחת. החבילה מורכבת מהקטגוריות הבאות:'),
  kv('נושאים (subjects)', 'עץ של נושאי לימוד ותתי-נושאים בכל עומק, עם סימון "הושלם" לכל פריט וקטגוריה.'),
  kv('משימות (tasks)', 'משימות יומיות, שבועיות וחודשיות, כולל משימות חוזרות ותאריך יעד.'),
  kv('מבחנים (exams)', 'מבחנים עתידיים ושעברו, עם תאריך, רמת הכנה (אדום/כתום/ירוק) וציון.'),
  kv('זמני לימוד (logs)', 'רישומי זמן לימוד — כמה דקות, באיזה תאריך, באיזה נושא ותיאור.'),
  kv('ארכיון מבחנים (archive)', 'רשומות מבחנים עצמאיות לתיעוד היסטורי וחישוב ממוצעים.'),
  kv('ארכיון זמנים (logsArchive)', 'רישומי זמן ישנים (מעל 7 ימים) שמועברים אוטומטית לארכיון כדי לשמור על ביצועים.'),
  spacer(),
  para('כל פריט במערכת מקבל מזהה ייחודי (id) אוטומטי בעת יצירתו, כך שאפשר לעדכן או למחוק אותו בוודאות.'),
);

// 5. המסכים
add(
  h1('5. המסכים באפליקציה'),
  para('הניווט מתבצע דרך תפריט תחתון (בנייד) או צדדי (במחשב). אלו המסכים:'),
  kv('ראשי (Dashboard)', 'מבט-על: ספירה לאחור למבחן הקרוב, כרטיס מיקוד, ומשימות היום.'),
  kv('נושאים', 'עץ נושאי הלימוד — הוספה, סימון התקדמות ומחיקה של תתי-נושאים.'),
  kv('משימות', 'ניהול משימות לפי יומיות / שבועיות / חודשיות.'),
  kv('לוח שנה', 'תצוגה חודשית של משימות ומבחנים לפי תאריך.'),
  kv('מבחנים', 'מבחנים קרובים עם חישוב "מוכנות" אוטומטי, והזנת ציונים.'),
  kv('זמן לימוד', 'רישום זמני לימוד, גרפים יומיים/שבועיים, וטיימר פומודורו וסשן לימוד.'),
  kv('ארכיון מבחנים', 'רשומות היסטוריות וממוצעי ציונים.'),
);

// 6. זרימות מפתח
add(
  h1('6. זרימות מפתח (איך הדברים עובדים)'),

  h2('א. התחברות והרשמה'),
  para('בעת הרשמה, השרת יוצר משתמש חדש ב-Supabase ומקצה לו חבילת נתונים ריקה. שם המשתמש מומר אוטומטית לכתובת דוא"ל פנימית. בעת התחברות מתקבל "אסימון" (JWT) שמאמת את המשתמש בכל פעולה. קיימת גם אפשרות התחברות דרך חשבון Google.'),

  h2('ב. טעינת נתונים'),
  para('מיד לאחר ההתחברות, האפליקציה מבקשת מהשרת את חבילת הנתונים של המשתמש, והשרת מחזיר אותה ממסד הנתונים. אם חסרים שדות (בגלל גרסה ישנה), מנגנון "מיגרציה" משלים אותם אוטומטית כדי למנוע תקלות.'),

  h2('ג. שמירה עמידה-לכשלים (Offline-First)'),
  para('זוהי אחת התכונות החשובות באפליקציה. כל שינוי שהמשתמש מבצע נשמר תחילה במכשיר עצמו ונכנס ל"תור שמירה". האפליקציה מנסה להעלות אותו לשרת מיד. אם החיבור נופל, השרת איטי, או האימות פג — השינוי לא הולך לאיבוד: הוא נשאר בתור ומסומן למשתמש (סימון "ממתין לסנכרון"), והמערכת מנסה שוב אוטומטית כשהחיבור חוזר או כשחוזרים לאפליקציה.'),

  h2('ד. שיחה עם עוזר ה-AI'),
  para('כשהמשתמש שואל שאלה, האפליקציה שולחת אותה לשרת יחד עם מצב הנתונים הנוכחי. השרת מזהה את כוונת השאלה (מבחנים? משימות? זמן לימוד?) ומכין רק את פרוסת הנתונים הרלוונטית — כך התשובה מהירה ומדויקת. השרת שולח את זה ל-Groq עם הוראה ברורה: "ענה רק מתוך הנתונים, אל תמציא, ואל תבצע פעולות". התשובה חוזרת בעברית. עוזר ה-AI הוא לקריאה בלבד — הוא לא משנה נתונים.'),
);

// 7. אבטחה ואמינות
add(
  h1('7. אבטחה ואמינות'),
  bullet('כל פעולה מול הנתונים דורשת אסימון אימות תקף — משתמש לא יכול לגשת לנתונים של אחר.'),
  bullet('המפתחות הרגישים (גישת מנהל למסד הנתונים, מפתח ה-AI) שמורים בשרת בלבד ואינם נחשפים בדפדפן.'),
  bullet('לפונקציית ה-AI הוגדר זמן ריצה מורחב ו"מנגנון נפילה רך": אם השירות איטי או מחזיר שגיאה, המשתמש מקבל הודעה ידידותית בעברית במקום קריסה.'),
  bullet('ה-Service Worker אף פעם לא שומר במטמון בקשות רגישות (התחברות, נתונים, AI) — רק קבצים סטטיים כמו העיצוב והלוגו.'),
);

// 8. תחזוקה ועדכון
add(
  h1('8. תחזוקה ושלבי עדכון'),
  h2('פריסת גרסה חדשה'),
  para('כל שינוי שנשמר ומועלה (push) למאגר הקוד נפרס אוטומטית על ידי Vercel. כדי לאלץ את המשתמשים לקבל גרסה חדשה של האפליקציה, יש להעלות את מספר הגרסה של המטמון בקובץ sw.js (השורה const CACHE = \'studyflow-v15\').'),
  h2('הגדרות שרת (משתני סביבה)'),
  para('בלוח הבקרה של Vercel מוגדרים המפתחות הסודיים: כתובת ומפתחות Supabase ומפתח Groq. חשוב להקפיד שלא תהיה רווח או שורה ריקה מיותרת בערכים — בעבר זה גרם לשגיאות אימות.'),
  h2('רענון מסמך זה'),
  para('מסמך זה נוצר אוטומטית על ידי סקריפט. כדי לעדכן אותו לאחר שינוי בקוד, בקשו "לרענן את תיעוד הארכיטקטורה" — התוכן יעודכן בקובץ docs/generate-architecture-doc.js והמסמך ייווצר מחדש על ידי הרצת הפקודה:'),
  para('node docs/generate-architecture-doc.js', { italics: true, color: ACCENT }),
);

// ─────────────────────────────────────────────────────────────
// בניית המסמך והפקתו
// ─────────────────────────────────────────────────────────────
const doc = new Document({
  creator: 'studyFlow docs generator',
  title: 'studyFlow — מסמך ארכיטקטורה',
  styles: {
    default: {
      document: { run: { font: FONT, rightToLeft: true } },
    },
  },
  sections: [{
    properties: {
      bidi: true, // יישור ברירת מחדל של הסעיף לימין
      page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } },
    },
    children,
  }],
});

const outPath = path.join(__dirname, 'studyFlow-ארכיטקטורה.docx');
Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(outPath, buf);
  console.log('✓ נוצר המסמך:', outPath);
});
