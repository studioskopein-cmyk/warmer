# Saves fixtures from a saved browser-tool result (JSON {rN: [...]}) into tools/fixtures.
import json,sys,os
out=os.path.join(os.path.dirname(os.path.abspath(__file__)),'fixtures')
f=sys.argv[1]; arr=json.load(open(f)); txt=arr[0]['text']
s=json.JSONDecoder().raw_decode(txt[txt.index('"'):])[0]; d=json.loads(s)
for k,v in d.items():
    json.dump(v,open(os.path.join(out,f'{k}.json'),'w')); print(k,[x['name']+(' ERR '+x['error'] if 'error' in x else '') for x in v])
