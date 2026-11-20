import os
os.environ['KMP_DUPLICATE_LIB_OK'] = 'TRUE'
os.environ['FLAGS_enable_pir_api'] = '0'
import sys
import logging
from flask import Flask, request, jsonify
from paddleocr import PaddleOCR

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger('PaddleServer')

app = Flask(__name__)

# Cache of PaddleOCR instances by language
ocr_instances = {}

def get_ocr(lang='en'):
    if lang not in ocr_instances:
        logger.info(f"Loading PaddleOCR model for lang: {lang}...")
        # use_angle_cls=True helps with rotated text often found in comics
        ocr_instances[lang] = PaddleOCR(use_angle_cls=True, lang=lang, enable_mkldnn=False)
        logger.info(f"Loaded PaddleOCR model for lang: {lang}")
    return ocr_instances[lang]

@app.route('/ocr', methods=['POST'])
def perform_ocr():
    data = request.json
    if not data or 'image_path' not in data:
        return jsonify({'error': 'Missing image_path'}), 400
    
    image_path = data['image_path']
    lang = data.get('lang', 'en')
    
    if not os.path.exists(image_path):
        return jsonify({'error': 'Image file not found'}), 400

    try:
        ocr = get_ocr(lang)
        # Run inference
        # result is a list of lines, where each line is:
        # [[ [x1,y1],[x2,y2],[x3,y3],[x4,y4] ], (text, confidence)]
        result = ocr.ocr(image_path)
        # Extract text and boxes
        page_results = result[0] if result and len(result) > 0 else None
        
        words = []
        full_text = []
        overall_conf = 0.0
        
        if page_results is not None:
            total_conf = 0
            
            # Handle new Paddlex format (PaddleOCR >= 3.5.0) where page_results is a dict
            if isinstance(page_results, dict):
                # Sometimes keys might be slightly different, let's try standard paddlex keys
                rec_texts = page_results.get('rec_text', page_results.get('rec_texts', []))
                dt_polys = page_results.get('dt_polys', [])
                rec_scores = page_results.get('rec_score', page_results.get('rec_scores', []))
                
                count = min(len(rec_texts), len(dt_polys)) if isinstance(rec_texts, list) else 0
                for i in range(count):
                    text = rec_texts[i]
                    # Score might be missing or shorter, default to 0.0
                    conf = float(rec_scores[i]) if i < len(rec_scores) else 0.0
                    box = dt_polys[i]
                    if hasattr(box, 'tolist'):
                        box = box.tolist()
                        
                    words.append({
                        'text': text,
                        'confidence': conf,
                        'box': box
                    })
                    full_text.append(text)
                    total_conf += conf
                
                if count > 0:
                    overall_conf = total_conf / count
                    
                # If we couldn't find the standard keys, dump the keys to the error for debugging
                elif len(page_results.keys()) > 0 and 'rec_text' not in page_results:
                    raise ValueError(f"Unrecognized Paddlex dict keys: {list(page_results.keys())}")
                    
            # Handle old PaddleOCR format (list of lines)
            elif isinstance(page_results, list):
                for line in page_results:
                    if not line or len(line) < 2:
                        continue
                    box = line[0]
                    text_info = line[1]
                    text = text_info[0]
                    conf = text_info[1]
                    
                    if hasattr(box, 'tolist'):
                        box = box.tolist()
                        
                    words.append({
                        'text': text,
                        'confidence': conf,
                        'box': box
                    })
                    full_text.append(text)
                    total_conf += conf
                    
                if len(words) > 0:
                    overall_conf = total_conf / len(words)

        return jsonify({
            'text': '\n'.join(full_text),
            'confidence': overall_conf,
            'words': words
        })
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        debug_info = str(e)
        if 'result' in locals():
            debug_info += f" | Result type: {type(result)} | Result: {str(result)[:500]}"
        return jsonify({'error': debug_info}), 500

if __name__ == '__main__':
    port = 3002
    logger.info(f"Starting PaddleOCR server on port {port}")
    # Run server
    app.run(host='127.0.0.1', port=port, debug=False)
