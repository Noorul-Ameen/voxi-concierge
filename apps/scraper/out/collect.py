import json,sys,glob,os
out='/home/claude/voxi/apps/scraper/out/chunks'
os.makedirs(out,exist_ok=True)
for p in sys.argv[1:]:
    d=json.load(open(p))
    for item in d:
        t=item.get('text','')
        if 'BEGIN' not in t: continue
        s=t.index('BEGIN')+5
        e=t.rindex('END') if 'END' in t[s:] else None
        body=t[s:e] if e else t[s:]
        # chunk index from length: identify by prefix hash
        i=len(glob.glob(out+'/*.txt'))
        open(f'{out}/c{i:02d}.txt','w').write(body)
        print(i,len(body),'complete' if e else 'TRUNCATED')
