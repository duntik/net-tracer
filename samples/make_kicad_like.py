"""Nasty test: KiCad-style export. All black; symbol bodies are closed polyline paths (no `re`);
wires 0.6pt, symbol graphics 1.0pt, bus 1.6pt; page content scaled via cm; rotated pin text;
power symbols (GND triangle, VCC bar) repeated with the same net label; zigzag resistor; transistor;
capacitor plates; junction dots as fill+stroke circles; dashed frame."""
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape

W, H = landscape(A4)
c = canvas.Canvas("./sample_kicad_like.pdf", pagesize=(W, H))
c.setTitle("KiCad-like test")
c.setStrokeColorRGB(0, 0, 0); c.setFillColorRGB(0, 0, 0)

# dashed frame (should become many tiny segments, harmless)
c.setLineWidth(0.4); c.setDash(3, 2); c.rect(15, 15, W - 30, H - 30); c.setDash()

c.saveState()
c.translate(30, 30); c.scale(0.9, 0.9)   # whole sheet drawn under a cm transform

def poly(pts, lw, close=False):
    c.setLineWidth(lw); p = c.beginPath(); p.moveTo(*pts[0])
    for q in pts[1:]:
        p.lineTo(*q)
    if close:
        p.close()
    c.drawPath(p, stroke=1, fill=0)

def wire(pts): poly(pts, 0.6)
def bus(pts): poly(pts, 1.6)
def gfx(pts, close=False): poly(pts, 1.0, close)
def dot(x, y): c.setLineWidth(0.6); c.circle(x, y, 1.8, stroke=1, fill=1)
def text(s, x, y, size=6, rot=0):
    c.saveState(); c.translate(x, y); c.rotate(rot); c.setFont("Helvetica", size); c.drawString(0, 0, s); c.restoreState()

def ic(name, x, y, w, h, L, R):
    gfx([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], close=True)
    text(name, x, y + h + 4, 7)
    for i, l in enumerate(L):
        py = y + h - 12 - i * 12; gfx([(x - 14, py), (x, py)]); text(l, x + 2, py - 2, 5); text(str(i + 1), x - 10, py + 1.5, 4)
    for i, l in enumerate(R):
        py = y + h - 12 - i * 12; gfx([(x + w, py), (x + w + 14, py)]); c.setFont("Helvetica", 5); c.drawRightString(x + w - 2, py - 2, l); text(str(len(L) + i + 1), x + w + 4, py + 1.5, 4)

def gnd(x, y):   # pin up at (x,y), triangle below
    gfx([(x, y), (x, y - 8)]); gfx([(x - 6, y - 8), (x + 6, y - 8), (x, y - 14)], close=True); text("GND", x - 6, y - 22, 5)

def vcc(x, y):   # pin down at (x,y), bar above
    gfx([(x, y), (x, y + 8)]); gfx([(x - 6, y + 8), (x + 6, y + 8)]); text("VCC", x - 6, y + 11, 5)

def res_zigzag(name, x, y):  # vertical, pins at (x,y) top and (x,y-40) bottom
    gfx([(x, y), (x, y - 8)]); gfx([(x, y - 8), (x + 4, y - 11), (x - 4, y - 17), (x + 4, y - 23), (x - 4, y - 29), (x, y - 32)]); gfx([(x, y - 32), (x, y - 40)])
    text(name, x + 7, y - 22, 5); text("1", x - 6, y - 4, 4); text("2", x - 6, y - 40, 4)

def cap(name, x, y):  # vertical, pins at (x,y) and (x,y-24)
    gfx([(x, y), (x, y - 9)]); gfx([(x - 6, y - 9), (x + 6, y - 9)]); gfx([(x - 6, y - 15), (x + 6, y - 15)]); gfx([(x, y - 15), (x, y - 24)])
    text(name, x + 8, y - 14, 5); text("1", x - 6, y - 4, 4); text("2", x - 6, y - 24, 4)

def npn(name, x, y):  # base pin at (x-14,y), collector at (x+8,y+16), emitter at (x+8,y-16)
    gfx([(x - 14, y), (x, y)]); gfx([(x, y - 8), (x, y + 8)])            # base pin + base bar
    gfx([(x, y + 4), (x + 8, y + 10), (x + 8, y + 16)]); gfx([(x, y - 4), (x + 8, y - 10), (x + 8, y - 16)])
    c.setLineWidth(1.0); c.circle(x + 3, y, 12, stroke=1, fill=0)
    text(name, x + 16, y - 2, 5); text("B", x - 12, y + 2, 4); text("C", x + 10, y + 12, 4); text("E", x + 10, y - 16, 4)

ic("U1 MCU", 300, 250, 120, 100, ["RESET", "PA0", "PA1", "PA2", "GND", "VCC"], ["TX", "RX", "PB0", "PB1", "SCL", "SDA"])
ic("U2 SENSOR", 600, 300, 80, 50, ["VDD", "GND", "SCL", "SDA"], [])
# vertical pin names on a connector drawn rotated
gfx([(120, 150), (180, 150), (180, 230), (120, 230)], close=True); text("J1 CONN", 120, 234, 7)
for i, l in enumerate(["V+", "GND", "TXD", "RXD"]):
    px = 130 + i * 14; gfx([(px, 150), (px, 136)]); text(l, px + 2, 152, 5, rot=90); text(str(i + 1), px - 4, 140, 4)

# wires
wire([(286, 338), (250, 338), (250, 400), (200, 400)]); text("RESET", 202, 402, 5)      # RESET -> net label
wire([(286, 290), (260, 290), (260, 200)]); gnd(260, 200)                                # U1.GND -> GND symbol
wire([(286, 278), (240, 278), (240, 420)]); vcc(240, 420)                                # U1.VCC -> VCC symbol
wire([(434, 338), (470, 338), (470, 180), (158, 180), (158, 136)])                      # TX -> J1.TXD  (crosses many)
wire([(434, 326), (480, 326), (480, 170), (172, 170), (172, 136)])                      # RX -> J1.RXD
wire([(434, 290), (520, 290), (520, 314), (586, 314)])                                   # SCL -> U2.SCL
wire([(434, 278), (530, 278), (530, 302), (586, 302)])                                   # SDA -> U2.SDA
wire([(586, 338), (560, 338), (560, 360)]); vcc(560, 360)                                # U2.VDD -> VCC
wire([(586, 326), (570, 326), (570, 250)]); gnd(570, 250)                                # U2.GND -> GND (wire runs down; separate symbol)
wire([(144, 136), (144, 110), (380, 110)]); gnd(380, 110)                                # J1.GND -> GND
wire([(130, 136), (130, 100), (100, 100), (100, 440)]); vcc(100, 440)                    # J1.V+ -> VCC
# pull-ups on SCL/SDA: resistors from VCC rail to the lines
wire([(240, 420), (240, 440), (500, 440), (500, 380)]); dot(240, 420)
res_zigzag("R1", 500, 380); wire([(500, 340), (500, 290)]); dot(500, 290); dot(500, 440)
wire([(500, 440), (515, 440), (515, 380)]); res_zigzag("R2", 515, 380); wire([(515, 340), (515, 278)]); dot(515, 278)
# transistor driven by PB0, emitter to GND, collector to a LED-ish net label
wire([(434, 314), (450, 314), (450, 230), (486, 230)]); npn("Q1", 500, 230)
wire([(508, 214), (508, 200)]); gnd(508, 200)
wire([(508, 246), (508, 260), (540, 260)]); text("LED_K", 541, 262, 5)
# decoupling cap between VCC rail and GND near U1
cap("C1", 220, 440); wire([(220, 440), (240, 440)]); dot(240, 440); wire([(220, 416), (220, 395)]); gnd(220, 395)
# bus (thick) with PA0..PA2 entries
bus([(200, 320), (200, 250), (200, 250)]); text("PA[0..2]", 190, 240, 5)
for i, nm in enumerate(["PA0", "PA1", "PA2"]):
    py = 326 - i * 12; wire([(286, py), (215, py)]); wire([(215, py), (200, py - 8)]); text(nm, 218, py + 2, 4)
wire([(600, 120), (640, 120), (640, 90)])   # deliberately dangling wire (both ends open)
c.restoreState()

c.setFont("Helvetica", 7); c.drawString(W - 200, 25, "KiCad-like test sheet")
c.showPage(); c.save()
print("ok")
