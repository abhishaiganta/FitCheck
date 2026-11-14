"""Build uncompressed, 64-byte-aligned USDZ sample models with metre units."""
import json
from math import cos, sin, tau
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_STORED
from struct import pack

OUT = Path(__file__).resolve().parents[1] / "public/models"
OUT.mkdir(parents=True, exist_ok=True)
WOOD = (.31, .13, .052)
OAK = (.57, .32, .12)
AMBER = (.78, .29, .045)
BRASS = (.53, .29, .095)
CREAM = (.83, .72, .57)
MOSS = (.22, .33, .12)

def profile(rings, color, segments=32):
    points = [(rx*cos(tau*i/segments), y, rz*sin(tau*i/segments))
              for y, rx, rz in rings for i in range(segments)]
    faces = [tuple(range(segments))]
    for layer in range(len(rings)-1):
        for i in range(segments):
            a = layer*segments+i
            b = layer*segments+(i+1)%segments
            faces.append((a,a+segments,b+segments,b))
    faces.append(tuple(reversed(range(len(points)-segments,len(points)))))
    return points, faces, color

def box(x, y, z, w, h, d, color):
    points = [(x+u*w/2,y+v*h/2,z+t*d/2)
              for v in (-1,1) for u,t in [(-1,-1),(1,-1),(1,1),(-1,1)]]
    faces = [(0,1,2,3),(7,6,5,4),(4,5,1,0),(5,6,2,1),(6,7,3,2),(7,4,0,3)]
    return points, faces, color

def furniture(index):
    if index in (1,5):
        floor=index==5
        lower=.77 if floor else .42
        return [
            profile([(0,.45,.45),(.05,.5,.5),(.09,.41,.41)],BRASS),
            profile([(.055,.045,.045),(lower+.09,.055,.055)],BRASS),
            profile([(lower,.46,.46),(lower+.04,.5,.5),(.89,.39,.39),(.96,.24,.24),(1,.065,.065)],CREAM if floor else AMBER),
        ]
    if index==2:
        return [profile([(0,.29,.29),(.045,.36,.36),(.12,.19,.19),(.88,.14,.14),(.94,.27,.27)],WOOD),
                profile([(.91,.48,.48),(.95,.5,.5),(1,.48,.48)],WOOD)]
    if index==3:
        return [box(0,.96,0,1,.08,1,OAK)]+[box(x,.46,z,.066,.92,.08,OAK) for x in (-.43,.43) for z in (-.42,.42)]
    if index==4:
        return [box(0,.43,0,1,.22,.89,MOSS),box(0,.71,-.4,1,.58,.2,MOSS)]+[box(x,.16,z,.09,.32,.09,WOOD) for x in (-.42,.42) for z in (-.36,.36)]
    if index==6:
        return [box(x,.5,0,.085,1,1,OAK) for x in (-.4575,.4575)]+[box(0,y,0,.86,.075,1,OAK) for y in (.04,.37,.67,.9625)]
    if index==7:
        return [profile([(0,.38,.38),(.09,.45,.45),(.75,.5,.5),(.93,.47,.47),(1,.38,.38)],OAK)]
    return [box(0,.56,0,1,.88,1,CREAM),box(0,.64,.491,.89,.32,.018,OAK),
            box(0,.64,.501,.22,.025,.035,BRASS)]+[box(x,.09,z,.1,.18,.1,WOOD) for x in (-.38,.38) for z in (-.37,.37)]

def mesh(index, part, dims):
    points,faces,color=part
    w,d,h=(n*.0254 for n in dims)
    xyz=", ".join(f"({x*w:.6f}, {y*h:.6f}, {z*d:.6f})" for x,y,z in points)
    counts=", ".join(str(len(face)) for face in faces)
    indices=", ".join(str(i) for face in faces for i in face)
    return f"""
    def Mesh "Part{index}"
    {{
        uniform token subdivisionScheme = "none"
        bool doubleSided = true
        point3f[] points = [{xyz}]
        int[] faceVertexCounts = [{counts}]
        int[] faceVertexIndices = [{indices}]
        color3f[] primvars:displayColor = [{color}]
        rel material:binding = </Furniture/Looks/Color{index}>
    }}"""

def material(index, color):
    return f"""
        def Material "Color{index}"
    {{
            token outputs:surface.connect = </Furniture/Looks/Color{index}/Preview.outputs:surface>
            def Shader "Preview"
    {{
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor = {color}
                float inputs:roughness = 0.45
                token outputs:surface
            }}
        }}"""

for i,dims in enumerate([(12,12,15),(18,18,22),(42,22,29),(29,30,32),(13,13,58),(32,12,30),(17,17,16),(17,15,22)],1):
    parts=furniture(i)
    # The browser uses the same geometry without relying on a USD parser.
    w,d,h=(n*.0254 for n in dims)
    orbit=[]
    for points,faces,color in parts:
        vertices=[[round(x*w,6),round(y*h,6),round(z*d,6)] for x,y,z in points]
        triangles=[index for face in faces for n in range(1,len(face)-1) for index in (face[0],face[n],face[n+1])]
        orbit.append(dict(vertices=vertices,triangles=triangles,color=color))
    (OUT/f'{i}.json').write_text(json.dumps(orbit,separators=(',',':')))
    source='#usda 1.0\n(\n defaultPrim = "Furniture"\n metersPerUnit = 1\n upAxis = "Y"\n)\ndef Xform "Furniture"\n    {\n'
    source+='    def Scope "Looks"\n    {'+''.join(material(n,part[2]) for n,part in enumerate(parts))+'\n    }'
    source+=''.join(mesh(n,part,dims) for n,part in enumerate(parts))+'\n}\n'
    with ZipFile(OUT/f'{i}.usdz','w',compression=ZIP_STORED) as archive:
        entry=ZipInfo('model.usda')
        pad=(-(30+len(entry.filename)+4))%64
        entry.extra=pack('<HH',0xFFFF,pad)+bytes(pad)
        archive.writestr(entry,source)
