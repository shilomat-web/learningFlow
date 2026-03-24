export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // המפתח ששמרנו בכספת של ורסל (חשוב: שים לב שקראת לו AI_API_KEY בורסל)
        const apiKey = process.env.AI_API_KEY; 
        
        // הכתובת של Groq שהייתה קודם חשופה בקוד שלך
        const apiUrl = 'https://api.groq.com/openai/v1/chat/completions';

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}` // המפתח נכנס כאן, בצד השרת בלבד
            },
            body: JSON.stringify(req.body)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            return res.status(response.status).json(errorData);
        }

        const data = await response.json();
        return res.status(200).json(data);

    } catch (error) {
        console.error("AI API Error:", error);
        return res.status(500).json({ error: 'Something went wrong with the AI', details: error.message });
    }
}