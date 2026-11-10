"""Доп. ячейки основы фасада для кронштейнов/утеплителя/направляющих там, где нет облицовки в геометрии."""
import json,gzip,array,sys
from collections import defaultdict
G=600
def quads(flat,fac=None,vis=None):
    o=[]
    for k in range(len(flat or [])//8):
        xs=flat[k*8:k*8+8:2]; ys=[-v for v in flat[k*8+1:k*8+8:2]]
        h=(fac[k]==-2) if fac else ((not vis[k]) if vis else False)
        if not h: o.append((min(xs),min(ys),max(xs),max(ys)))
    return o
class Idx:
    def __init__(s,qs,C=2000):
        s.q=qs; s.C=C; s.m=defaultdict(list)
        for i,q in enumerate(qs):
            for cx in range(int(q[0]//C),int(q[2]//C)+1):
                for cy in range(int(q[1]//C),int(q[3]//C)+1): s.m[(cx,cy)].append(i)
    def hit(s,x,y): return any(s.q[i][0]<=x<=s.q[i][2] and s.q[i][1]<=y<=s.q[i][3] for i in s.m[(int(x//s.C),int(y//s.C))])
def cells_in(q):
    for cx in range(int(q[0]//G),int(q[2]//G)+1):
        for cy in range(int(q[1]//G),int(q[3]//G)+1):
            x=(cx+.5)*G; y=(cy+.5)*G
            if q[0]<=x<=q[2] and q[1]<=y<=q[3]: yield (cx,cy)
def run(cid, write):
    fn=f'projects/v14/data/{cid}.json.gz'
    d=json.load(gzip.open(fn))
    clad=quads(d['panels'],d['panelsFac'])
    for k in ('akp','sfb','keramogranit'): clad+=quads(d.get(k),d.get(k+'Fac'))
    cov=Idx(clad); win=Idx(quads(d.get('windows'),d.get('windowsFac')))
    exact=set()
    for k in ('monolith','insulGrid'):
        for q in quads(d.get(k),None,d.get(k+'Vis')): exact.update(cells_in(q))
    # плитки, нарисованные в АР заливкой, но не попавшие в геометрию панелей
    buf=array.array('i'); buf.frombytes(gzip.open(f'projects/v14/data/{cid}.ar.bin.gz').read()); o=0
    for g in d['ar']['groups']:
        lens=buf[o:o+g['n']]; o+=g['n']; p=o
        take = g['k']=='f' and g.get('p')=='SOLID' and (g['c']=='#7aafdf' or 'Композит' in g['layer'])
        for L in lens:
            x=y=0; xs=[]; ys=[]
            for j in range(L): x+=buf[p]; y+=buf[p+1]; p+=2; xs.append(x); ys.append(y)
            if take and L in (4,5): exact.update(cells_in((min(xs),min(ys),max(xs),max(ys))))
        o+=2*g['m']
    br=set()
    for k in ('brackets','rails'):
        for q in quads(d.get(k),None,d.get(k+'Vis')): br.add((int(((q[0]+q[2])/2)//G),int(((q[1]+q[3])/2)//G)))
    # закрытие (дилатация+эрозия) по кронштейнам: промежутки между ними до ~2.4 м
    R=2
    dil=set((x+i,y+j) for x,y in br for i in range(-R,R+1) for j in range(-R,R+1))
    clo=set(c for c in dil if all((c[0]+i,c[1]+j) in dil for i in range(-R,R+1) for j in range(-R,R+1)))
    clo|=br
    ctr=lambda c:((c[0]+.5)*G,(c[1]+.5)*G)
    out=set(c for c in exact if not cov.hit(*ctr(c)))
    anchor=Idx([(q[0]-2000,q[1]-2000,q[2]+2000,q[3]+2000) for q in clad]+[(c[0]*G-2000,c[1]*G-2000,c[0]*G+G+2000,c[1]*G+G+2000) for c in out])
    for c in clo:
        if c in out: continue
        x,y=ctr(c)
        if cov.hit(x,y): continue
        if c not in br and win.hit(x,y): continue
        if not anchor.hit(x,y): continue   # схемы кронштейнов в стороне от фасадов
        out.add(c)
    out=sorted(out, key=lambda c:(c[1],c[0]))
    flat=[]; fac=[]
    for cx,cy in out:
        x0,y0,x1,y1=cx*G,cy*G,cx*G+G,cy*G+G
        flat+= [x0,-y0, x1,-y0, x1,-y1, x0,-y1]
        X=(x0+x1)/2; Yf=-(y0+y1)/2; f=-1
        for i,F in enumerate(d['facades']):
            if any(b[0]<=X<=b[2] and b[1]<=Yf<=b[3] for b in F['boxes']): f=i; break
        fac.append(f)
    nb=sum(1 for c in br if not cov.hit(*ctr(c)) and c not in set(out))
    print(cid,'cells',len(out),'exact',len(exact),'brackets still outside',nb)
    if write:
        d['baseExtra']=flat; d['baseExtraFac']=fac
        with gzip.open(fn,'wt',compresslevel=9) as f: json.dump(d,f,ensure_ascii=False,separators=(',',':'))
    return d,out
if __name__=='__main__':
    for c in ['corpus1','corpus2','corpus3','corpus4','corpus5']: run(c, '--write' in sys.argv)
