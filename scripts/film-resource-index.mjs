import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(path.join(root,'data','open_ai_canvas.db'), {readOnly:true});
const rows = db.prepare("SELECT id,kind,object_key,width,height,duration_ms,created_at FROM resources WHERE kind='image' AND status='ready' ORDER BY created_at DESC LIMIT 22").all();
console.log(JSON.stringify(rows.map(r=>({...r,path:path.join(root,'data','resources',r.object_key)})),null,2));
db.close();
