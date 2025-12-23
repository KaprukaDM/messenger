from flask import Flask, request
import requests

app = Flask(__name__)

PAGE_ACCESS_TOKEN = "your_page_access_token_here"  # Replace this
VERIFY_TOKEN = "my_verify_token_123"

@app.route('/webhook', methods=['GET'])
def verify_webhook():
    token = request.args.get('hub.verify_token')
    challenge = request.args.get('hub.challenge')
    if token == VERIFY_TOKEN:
        return challenge
    return 'Invalid verification token', 403

@app.route('/webhook', methods=['POST'])
def webhook():
    data = request.get_json()
    print("MESSAGE RECEIVED:", data)
    
    if data.get('object') == 'page':
        for entry in data.get('entry', []):
            for messaging_event in entry.get('messaging', []):
                sender_id = messaging_event['sender']['id']
                
                if 'message' in messaging_event:
                    message_text = messaging_event['message'].get('text', '')
                    print(f"From: {sender_id}, Text: {message_text}")
                    
                    # Send reply
                    send_message(sender_id, f"You said: {message_text}")
    
    return 'OK', 200

def send_message(recipient_id, message_text):
    url = f"https://graph.facebook.com/v21.0/me/messages?access_token={PAGE_ACCESS_TOKEN}"
    data = {
        "recipient": {"id": recipient_id},
        "message": {"text": message_text}
    }
    response = requests.post(url, json=data)
    print("Reply sent:", response.status_code)
    return response

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=10000)
