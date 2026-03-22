// ניהול המצב של האפליקציה בזיכרון המקומי
let state = JSON.parse(localStorage.getItem('study_state')) || {
    subjects: [],
    pastExams: [] // ארכיון המבחנים החדש
};

// שימוש במודל החדש שלא מחזיר שגיאת 404
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent";

function getApiKey() {
    let key = localStorage.getItem('gemini_api_key');
    if (!key) {
        key = prompt("אנא הכנס את מפתח ה-API של Gemini (API Key):");
        if (key) localStorage.setItem('gemini_api_key', key);
    }
    return key;
}

// בניית ההקשר (RAG) שה-AI יקרא לפני שהוא עונה
function buildContext() {
    let context = "נתוני האפליקציה הנוכחיים:\n";
    context += "נושאי לימוד (JSON): " + JSON.stringify(state.subjects) + "\n";
    context += "ארכיון מבחני עבר (JSON): " + JSON.stringify(state.pastExams) + "\n";
    return context;
}

// פונקציית השליחה המרכזית לצ'אט
async function sendMessage() {
    const input = document.getElementById('user-input');
    const msg = input.value.trim();
    if (!msg) return;

    addMessage(msg, 'user-msg');
    input.value = '';

    const apiKey = getApiKey();
    if (!apiKey) {
        addMessage("חסר מפתח API. רענן את העמוד כדי להזין אותו שוב.", 'ai-msg');
        return;
    }

    const context = buildContext();

    try {
        const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ 
                        text: `You are a strict learning assistant. Use ONLY the following JSON data to answer: ${context}. 
                        Instruction from user: "${msg}". 
                        Answer ONLY in Hebrew. Do not hallucinate external facts.` 
                    }]
                }]
            })
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }

        const data = await response.json();
        const aiText = data.candidates[0].content.parts[0].text;
        addMessage(aiText, 'ai-msg');
        
    } catch (err) {
        console.error(err);
        addMessage("שגיאה בחיבור ל-AI. ייתכן שמפתח ה-API שגוי או שיש בעיית רשת.", 'ai-msg');
    }
}

// פונקציות עזר לתצוגה
function addMessage(text, className) {
    const div = document.createElement('div');
    div.className = `message ${className}`;
    div.innerText = text;
    document.getElementById('chat-messages').appendChild(div);
    
    // גלילה אוטומטית למטה
    const chatContainer = document.getElementById('chat-messages');
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function toggleChat() {
    const win = document.getElementById('chat-window');
    win.style.display = win.style.display === 'flex' ? 'none' : 'flex';
}

// פונקציה להוספת מבחן לארכיון (תשתית לפעולות עתידיות של ה-AI)
function addPastExamToArchive(name, date, score) {
    state.pastExams.push({ id: Date.now(), name, date, score });
    localStorage.setItem('study_state', JSON.stringify(state));
    renderExams();
}

// תצוגת המבחנים במסך הראשי
function renderExams() {
    const list = document.getElementById('exams-list');
    if (state.pastExams.length === 0) {
        list.innerHTML = "<div style='color: #a0aec0; font-size: 14px;'>אין עדיין מבחנים בארכיון.</div>";
        return;
    }
    
    list.innerHTML = state.pastExams.map(exam => 
        `<div class="exam-item">
            <strong>${exam.name || 'מבחן'}</strong> - ${exam.date || 'תאריך לא ידוע'} 
            (ציון: ${exam.score || '-'})
        </div>`
    ).join('');
}

// הפעלה ראשונית של התצוגה כשפותחים את האתר
renderExams();