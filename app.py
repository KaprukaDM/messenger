import os
import requests
import json
import re
from flask import Flask, request
from openai import OpenAI
import gspread
from oauth2client.service_account import ServiceAccountCredentials
from datetime import datetime

app = Flask(__name__)

# Environment Variables
VERIFY_TOKEN = os.environ.get("VERIFY_TOKEN")
GRAPH_API_VERSION = os.environ.get("GRAPH_API_VERSION", "v24.0")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
GOOGLE_SHEETS_CREDS = os.environ.get("GOOGLE_SHEETS_CREDS")
SHEET_NAME = os.environ.get("SHEET_NAME", "Messenger_Bot_Data")

# Multi-page support
PAGE_ID_1 = os.environ.get("PAGE_ID_1")
PAGE_ACCESS_TOKEN_1 = os.environ.get("PAGE_ACCESS_TOKEN_1")
PAGE_ID_2 = os.environ.get("PAGE_ID_2")
PAGE_ACCESS_TOKEN_2 = os.environ.get("PAGE_ACCESS_TOKEN_2")
PAGE_ID_3 = os.environ.get("PAGE_ID_3")
PAGE_ACCESS_TOKEN_3 = os.environ.get("PAGE_ACCESS_TOKEN_3")

# Create page mapping
PAGE_MAP = {}
if PAGE_ID_1 and PAGE_ACCESS_TOKEN_1:
    PAGE_MAP[PAGE_ID_1] = PAGE_ACCESS_TOKEN_1
if PAGE_ID_2 and PAGE_ACCESS_TOKEN_2:
    PAGE_MAP[PAGE_ID_2] = PAGE_ACCESS_TOKEN_2
if PAGE_ID_3 and PAGE_ACCESS_TOKEN_3:
    PAGE_MAP[PAGE_ID_3] = PAGE_ACCESS_TOKEN_3

# Initialize OpenAI
client = OpenAI(api_key=OPENAI_API_KEY)

# Initialize Google Sheets
def get_sheet():
    try:
        creds_dict = json.loads(GOOGLE_SHEETS_CREDS)
        scope = ['https://spreadsheets.google.com/feeds', 'https://www.googleapis.com/auth/drive']
        creds = ServiceAccountCredentials.from_json_keyfile_dict(creds_dict, scope)
        gc = gspread.authorize(creds)
        return gc.open(SHEET_NAME)
    except Exception as e:
        print(f"Google Sheets connection error: {e}", flush=True)
        return None

@app.route("/", methods=["GET", "POST"])
def health():
    if request.method == "GET" and request.args.get("hub.mode"):
        mode = request.args.get("hub.mode")
        token = request.args.get("hub.verify_token")
        challenge = request.args.get("hub.challenge")

        if mode == "subscribe" and token == VERIFY_TOKEN:
            print("ROOT verification successful", flush=True)
            return challenge, 200

        return "Forbidden", 403

    return "OK", 200

@app.route("/webhook", methods=["GET", "POST"])
def webhook():
    if request.method == "GET":
        mode = request.args.get("hub.mode")
        token = request.args.get("hub.verify_token")
        challenge = request.args.get("hub.challenge")

        if mode == "subscribe" and token == VERIFY_TOKEN:
            print("Webhook verification successful", flush=True)
            return challenge, 200

        return "Forbidden", 403

    if request.method == "POST":
        data = request.get_json()
        print("Webhook payload:", data, flush=True)

        if "entry" in data:
            for entry in data["entry"]:
                page_id = entry.get("id")
                page_token = PAGE_MAP.get(page_id)

                messaging_events = entry.get("messaging", [])
                for event in messaging_events:
                    sender_id = event["sender"]["id"]

                    # Handle referral (ad tracking)
                    if "referral" in event:
                        ad_id = event["referral"].get("ref")
                        handle_ad_referral(sender_id, ad_id, page_token)

                    # Handle postback (button clicks)
                    if "postback" in event:
                        handle_postback(sender_id, event["postback"], page_token)

                    # Handle messages
                    if event.get("message") and "text" in event["message"]:
                        text = event["message"]["text"]
                        print(f"Message from {sender_id}: {text}", flush=True)
                        handle_message(sender_id, text, page_token)

        return "EVENT_RECEIVED", 200

def handle_ad_referral(sender_id, ad_id, page_token):
    """Handle new user from Click-to-Messenger ad"""
    try:
        # Save initial referral
        save_message(sender_id, ad_id, "system", f"User arrived from ad {ad_id}")

        # Send product images
        send_product_images_for_ad(sender_id, ad_id, page_token)

        # Send quick reply buttons
        send_quick_replies(sender_id, page_token)

        print(f"Ad referral: sender={sender_id}, ad_id={ad_id}", flush=True)
    except Exception as e:
        print(f"Error in handle_ad_referral: {e}", flush=True)

def handle_postback(sender_id, postback_data, page_token):
    """Handle button clicks"""
    payload = postback_data.get("payload")

    if payload == "GET_STARTED":
        handle_message(sender_id, "Hello", page_token)

def send_quick_replies(sender_id, page_token):
    """Send automated quick reply questions after ad click"""
    if not page_token:
        return

    url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/me/messages"
    params = {"access_token": page_token}

    # Question 1: Name, Address, Phone
    payload1 = {
        "recipient": {"id": sender_id},
        "messaging_type": "RESPONSE",
        "message": {
            "text": "කරුණාකර මෙම විස්තර එවන්න:",
            "quick_replies": [
                {
                    "content_type": "text",
                    "title": "විස්තර එවන්න",
                    "payload": "SEND_DETAILS"
                }
            ]
        }
    }

    requests.post(url, params=params, json=payload1)
    print("Sent quick reply 1", flush=True)

def handle_message(sender_id, text, page_token):
    """Main message handler"""
    try:
        # Get user's ad_id
        ad_id = get_user_ad_id(sender_id)

        # Save user message
        save_message(sender_id, ad_id, "user", text)

        # Detect language
        language = detect_language(text)

        # Check if user wants photos
        wants_photos = detect_photo_request(text)

        # Check for order placement
        order_detected = detect_order_placement(text)

        # Extract lead info - IMPROVED EXTRACTION
        lead_info = extract_lead_info(text)
        if lead_info:
            save_lead(sender_id, ad_id, lead_info)

        # Get conversation history - IMPORTANT FOR CONTEXT
        history = get_conversation_history(sender_id, limit=12)

        # Get products
        products_context = None
        product_images = []

        if ad_id:
            products_context, product_images = get_products_for_ad(ad_id)
        else:
            # Only search if user mentions a product
            products_context, product_images = search_products_by_query(text)

        # If user wants photos, send them
        if wants_photos and product_images:
            for img_url in product_images[:3]:
                send_image(sender_id, img_url, page_token)
            reply_text = "මෙන්න photos! Order කරන්න කැමතිද?

Dear 💙"
        else:
            # Generate AI response with FULL CONTEXT
            reply_text = get_ai_response(text, history, products_context, language, order_detected, lead_info, ad_id)

        # Save bot response
        save_message(sender_id, ad_id, "assistant", reply_text)

        # If order was placed, save to Leads
        if order_detected and lead_info:
            save_order_to_leads(sender_id, ad_id, lead_info, products_context)

        # Send reply
        send_message(sender_id, reply_text, page_token)

    except Exception as e:
        print(f"Error in handle_message: {e}", flush=True)
        send_message(sender_id, "Sorry, I'm having trouble. Please try again. Dear 💙", page_token)

def detect_language(text):
    """Detect if user is speaking Sinhala, English, or Singlish"""
    sinhala_pattern = re.compile('[\u0D80-\u0DFF]')
    has_sinhala = bool(sinhala_pattern.search(text))

    english_words = re.findall(r'\b[a-zA-Z]+\b', text)
    has_english = len(english_words) > 0

    if has_sinhala and has_english:
        return "singlish"
    elif has_sinhala:
        return "sinhala"
    else:
        return "english"

def detect_photo_request(text):
    """Detect if user wants to see photos"""
    photo_keywords = ['photo', 'photos', 'pic', 'pics', 'picture', 'image', 
                      'wena', 'පින්තූර', 'photo එක', 'pics දෙන්න']
    text_lower = text.lower()
    return any(keyword in text_lower for keyword in photo_keywords)

def detect_order_placement(text):
    """Detect if customer is placing an order"""
    order_keywords = [
        'order', 'ඕඩර්', 'ගන්නම්', 'ගන්න', 'කරන්න', 'confirm', 
        'ගන්නවා', 'ඕනා', 'ඕන', 'එකක්', 'දෙන්න', 'යවන්න', 'place'
    ]
    text_lower = text.lower()
    return any(keyword in text_lower for keyword in order_keywords)

def extract_lead_info(text):
    """IMPROVED: Extract name, phone, address from message"""
    info = {}

    # Extract Sri Lankan phone numbers
    phone_patterns = [
        r'(0\d{9})',
        r'(\+94\d{9})',
        r'(94\d{9})'
    ]
    for pattern in phone_patterns:
        match = re.search(pattern, text.replace(' ', ''))
        if match:
            info['phone'] = match.group(1)
            break

    # Extract address - look for address patterns
    # Check if message contains location info (No:, road, galle, colombo, etc)
    location_indicators = ['no:', 'no.', 'road', 'street', 'galle', 'colombo', 
                          'kandy', 'negombo', 'kalutara', 'පාර', 'නැ', 'අංක']

    if any(indicator in text.lower() for indicator in location_indicators):
        # Extract text that looks like an address (before phone number if present)
        address_text = text
        if info.get('phone'):
            # Get text before phone number
            address_text = text.split(info['phone'])[0]

        # Clean and extract address
        address_text = address_text.strip()
        if len(address_text) > 10:  # Reasonable address length
            info['address'] = address_text[:200]

    # Extract name - look for common patterns
    # Check if text starts with a name or contains "name is"
    name_patterns = [
        r'(?:name|නම)\s*(?:is|:)?\s*([A-Za-z\s]{3,30})',
        r'^([A-Z][a-z]+\s+[A-Z][a-z]+)',  # Capitalized names at start
    ]

    for pattern in name_patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            potential_name = match.group(1).strip()
            # Avoid capturing common words
            if potential_name.lower() not in ['order', 'please', 'delivery', 'කරන්න']:
                info['name'] = potential_name[:50]
                break

    return info if info else None

def get_ai_response(user_message, history, products_context, language, order_detected, lead_info, ad_id):
    """Generate AI response - VERY SHORT, context-aware, no hallucinations"""
    try:
        # Build context-aware system prompt
        if language == "sinhala":
            system_prompt = """ඔබ සරල විකුණුම් සහායකයෙක්.

ප්‍රධාන නීති:
1. අතිශයින් කෙටි පිළිතුරු (1-2 වාක්‍ය පමණ)
2. සංවාදයේ context මතක තබාගන්න
3. ලබා දී ඇති නිෂ්පාදන විතරක් කතා කරන්න - තියෙන දේවල් ගැන විතරයි
4. නැති නිෂ්පාදන ගැන කියන්න එපා
5. User order කරනවා නම්, කුමන product එකද දන්න ඕන (සංවාදයෙන්)
6. Photos අහනවා නම්, "මෙන්න photos එවනවා" කියන්න
7. සෑම පණිවිඩයම "Dear 💙" එකද අවසන් කරන්න

Delivery: Rs.350 fixed, COD available

කෙටි, ස්වාභාවික, casual Sinhala භාවිතා කරන්න!"""

        elif language == "singlish":
            system_prompt = """You are a simple sales assistant.

Key rules:
1. VERY short replies (1-2 sentences only)
2. Remember conversation context
3. Only talk about products that are provided - don't make up products
4. Don't mention products that don't exist
5. If user wants to order, know which product from conversation
6. If photos requested, say "sending photos now"
7. End with "Dear 💙"

Delivery: Rs.350 fixed, COD available

Short, natural, casual Singlish!"""

        else:
            system_prompt = """You are a simple sales assistant.

Key rules:
1. VERY short replies (1-2 sentences only)
2. Remember conversation context
3. Only mention products that exist in the provided data
4. Don't hallucinate or make up products
5. If user wants to order, identify product from conversation
6. If photos requested, confirm sending
7. End with "Dear 💙"

Delivery: Rs.350 fixed, COD available"""

        # Add products context ONLY if available
        if products_context:
            system_prompt += f"\n\nAvailable products ONLY:\n{products_context}"
        else:
            system_prompt += "\n\nNO products data available. Don't suggest any products."

        # Build messages with FULL history for context
        messages = [{"role": "system", "content": system_prompt}]

        # Add all conversation history so AI remembers context
        for msg in history:
            messages.append({"role": msg["role"], "content": msg["message"]})

        # Add current message
        messages.append({"role": "user", "content": user_message})

        # Call OpenAI - very short
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            max_tokens=100,  # VERY short
            temperature=0.7
        )

        reply = response.choices[0].message.content.strip()

        # Ensure "Dear 💙" at end
        if not reply.endswith("Dear 💙"):
            reply = reply + "\n\nDear 💙"

        return reply

    except Exception as e:
        print(f"OpenAI error: {e}", flush=True)
        if language == "sinhala" or language == "singlish":
            return "මට දැන් ප්‍රතිචාර දැක්වීමට අපහසුයි. Dear 💙"
        else:
            return "Sorry, having trouble. Dear 💙"

def get_products_for_ad(ad_id):
    """Get products from Google Sheets for specific ad_id"""
    try:
        sheet = get_sheet()
        if not sheet:
            return None, []

        ad_products_sheet = sheet.worksheet("Ad_Products")
        records = ad_products_sheet.get_all_records()

        for row in records:
            if str(row.get("ad_id")) == str(ad_id):
                products_text = ""
                image_urls = []

                for i in range(1, 6):
                    name_key = f"product_{i}_name"
                    price_key = f"product_{i}_price"
                    image_key = f"product_{i}_image_1"

                    if row.get(name_key):
                        products_text += f"{row[name_key]} - {row.get(price_key, '')}\n"

                        if row.get(image_key):
                            img_url = row[image_key]
                            if img_url and img_url.startswith("http"):
                                image_urls.append(img_url)

                return products_text, image_urls

        return None, []

    except Exception as e:
        print(f"Error getting products: {e}", flush=True)
        return None, []

def send_product_images_for_ad(sender_id, ad_id, page_token):
    """Send product images at conversation start"""
    try:
        _, image_urls = get_products_for_ad(ad_id)

        for img_url in image_urls[:3]:  # Max 3 images
            send_image(sender_id, img_url, page_token)

    except Exception as e:
        print(f"Error sending images: {e}", flush=True)

def send_image(recipient_id, image_url, page_token):
    """Send an image via Messenger"""
    if not page_token:
        return

    url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/me/messages"
    params = {"access_token": page_token}
    payload = {
        "recipient": {"id": recipient_id},
        "message": {
            "attachment": {
                "type": "image",
                "payload": {
                    "url": image_url,
                    "is_reusable": True
                }
            }
        }
    }

    r = requests.post(url, params=params, json=payload)
    print(f"Send image: {r.status_code}", flush=True)

def search_products_by_query(query):
    """AI-powered product search - NO HALLUCINATIONS"""
    try:
        # Extract keywords
        keyword_response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "Extract product search keywords. Return only keywords, comma separated."},
                {"role": "user", "content": query}
            ],
            max_tokens=30
        )

        keywords = keyword_response.choices[0].message.content.lower()
        print(f"Search keywords: {keywords}", flush=True)

        # Search in Google Sheets
        sheet = get_sheet()
        if not sheet:
            return None, []

        ad_products_sheet = sheet.worksheet("Ad_Products")
        records = ad_products_sheet.get_all_records()

        found_products = []
        found_images = []

        for row in records:
            for i in range(1, 6):
                name = str(row.get(f"product_{i}_name", "")).lower()

                if name and any(kw.strip() in name for kw in keywords.split(",")):
                    prod_name = row.get(f"product_{i}_name")
                    prod_price = row.get(f"product_{i}_price")

                    if prod_name and prod_name not in [p['name'] for p in found_products]:
                        found_products.append({"name": prod_name, "price": prod_price})

                        img_url = row.get(f"product_{i}_image_1")
                        if img_url and img_url.startswith("http"):
                            found_images.append(img_url)

        if found_products:
            products_text = ""
            for prod in found_products[:3]:
                products_text += f"{prod['name']} - {prod['price']}\n"

            return products_text, found_images[:3]

        return None, []

    except Exception as e:
        print(f"Error in search: {e}", flush=True)
        return None, []

def save_message(sender_id, ad_id, role, message):
    """Save message to Conversations"""
    try:
        sheet = get_sheet()
        if not sheet:
            return

        conversations_sheet = sheet.worksheet("Conversations")
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        conversations_sheet.append_row([
            sender_id,
            ad_id or "",
            timestamp,
            role,
            message
        ])

    except Exception as e:
        print(f"Error saving message: {e}", flush=True)

def get_conversation_history(sender_id, limit=12):
    """Get conversation history with limit"""
    try:
        sheet = get_sheet()
        if not sheet:
            return []

        conversations_sheet = sheet.worksheet("Conversations")
        records = conversations_sheet.get_all_records()

        user_messages = [r for r in records if str(r.get("sender_id")) == str(sender_id)]
        user_messages = user_messages[-limit:]

        return [{"role": m["role"], "message": m["message"]} for m in user_messages if m["role"] in ["user", "assistant"]]

    except Exception as e:
        print(f"Error getting history: {e}", flush=True)
        return []

def get_user_ad_id(sender_id):
    """Get ad_id for this user"""
    try:
        sheet = get_sheet()
        if not sheet:
            return None

        conversations_sheet = sheet.worksheet("Conversations")
        records = conversations_sheet.get_all_records()

        for record in reversed(records):
            if str(record.get("sender_id")) == str(sender_id):
                ad_id = record.get("ad_id")
                if ad_id:
                    return ad_id

        return None

    except Exception as e:
        print(f"Error getting ad_id: {e}", flush=True)
        return None

def save_lead(sender_id, ad_id, lead_info):
    """Save/update lead information"""
    try:
        sheet = get_sheet()
        if not sheet:
            return

        leads_sheet = sheet.worksheet("Leads")
        records = leads_sheet.get_all_records()

        row_index = None
        for idx, record in enumerate(records, start=2):
            if str(record.get("Sender ID")) == str(sender_id):
                row_index = idx
                break

        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        if row_index:
            # Update existing
            if lead_info.get('name'):
                leads_sheet.update_cell(row_index, 3, lead_info['name'])
            if lead_info.get('address'):
                leads_sheet.update_cell(row_index, 4, lead_info['address'])
            if lead_info.get('phone'):
                leads_sheet.update_cell(row_index, 5, lead_info['phone'])
            leads_sheet.update_cell(row_index, 7, timestamp)
        else:
            # New lead
            leads_sheet.append_row([
                sender_id,
                ad_id or "",
                lead_info.get('name', ''),
                lead_info.get('address', ''),
                lead_info.get('phone', ''),
                "",
                timestamp,
                "new"
            ])

        print(f"Saved lead: {lead_info}", flush=True)

    except Exception as e:
        print(f"Error saving lead: {e}", flush=True)

def save_order_to_leads(sender_id, ad_id, lead_info, products_context):
    """Save order to Leads"""
    try:
        sheet = get_sheet()
        if not sheet:
            return

        leads_sheet = sheet.worksheet("Leads")
        records = leads_sheet.get_all_records()

        row_index = None
        for idx, record in enumerate(records, start=2):
            if str(record.get("Sender ID")) == str(sender_id):
                row_index = idx
                break

        product_name = "Order Placed"
        if products_context:
            lines = products_context.split('\n')
            for line in lines:
                if line.strip() and ' - ' in line:
                    product_name = line.strip().split(' - ')[0][:50]
                    break

        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        if row_index:
            leads_sheet.update_cell(row_index, 6, product_name)
            leads_sheet.update_cell(row_index, 7, timestamp)
            leads_sheet.update_cell(row_index, 8, "ordered")

    except Exception as e:
        print(f"Error saving order: {e}", flush=True)

def send_message(recipient_id, text, page_token):
    """Send text message"""
    if not page_token:
        return

    url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/me/messages"
    params = {"access_token": page_token}
    payload = {
        "recipient": {"id": recipient_id},
        "message": {"text": text}
    }

    r = requests.post(url, params=params, json=payload)
    print(f"Send message: {r.status_code}", flush=True)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
