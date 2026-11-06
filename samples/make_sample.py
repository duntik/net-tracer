"""Run from the samples/ folder.
Generates a vector test schematic that mimics an EasyEDA PDF export,
and the same data as lib/demo.js for the in-browser demo button.
Coordinates are PDF-style (y up), pt units, A4 landscape."""
import json
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape

W, H = landscape(A4)

# name, x, y, w, h, left pins, right pins, top pins, bottom pins
COMPS = [
    ("U1  ESP32_DevKit", 330, 300, 120, 150,
     ["3V3", "GND", "D15", "D2", "D4", "RX2", "TX2", "D5", "D18", "D19", "D21", "RX0", "TX0"],
     ["VIN", "GND", "D13", "D12", "D14", "D27", "D26", "D25", "D33", "D32", "D35", "D34", "VN"], [], []),
    ("U2  TP4056", 80, 360, 90, 60, ["IN+", "IN-"], ["OUT+", "OUT-", "B+", "B-"], [], []),
    ("U3  MT3608", 80, 220, 90, 50, ["VIN+", "VIN-"], ["VOUT+", "VOUT-"], [], []),
    ("H1  HEADER 8", 600, 330, 60, 120, ["BUSY", "RST", "DC", "CS", "CLK", "DIN", "GND", "VCC"], [], [], []),
    ("S1  MAX485", 560, 160, 110, 60, ["RO", "RE", "DE", "DI"], ["VCC", "B", "A", "GND"], [], []),
    ("R1", 220, 120, 40, 40, [], [], ["1"], ["2"]),
    ("C1", 400, 120, 40, 40, [], [], ["+"], ["-"]),
]
WIRES = [
    # VIN
    [(180, 410), (250, 410), (250, 470), (485, 470), (485, 440), (460, 440)],
    [(250, 410), (250, 290), (60, 290), (60, 260), (70, 260)],
    [(410, 170), (410, 190), (485, 190), (485, 470)],
    # GND
    [(180, 400), (210, 400), (210, 430), (320, 430)],
    [(210, 400), (210, 280), (50, 280), (50, 250), (70, 250)],
    [(460, 430), (500, 430), (500, 100), (690, 100), (690, 180), (680, 180)],
    [(500, 100), (160, 100), (160, 280)],
    [(590, 380), (540, 380), (540, 430), (500, 430)],
    [(410, 110), (410, 100)],
    # 3V3
    [(320, 440), (300, 440), (300, 500), (580, 500), (580, 370), (590, 370)],
    [(230, 170), (230, 300), (300, 300), (300, 440)],
    # header signals
    [(320, 370), (290, 370), (290, 510), (570, 510), (570, 410), (590, 410)],   # D5 -> CS
    [(320, 360), (280, 360), (280, 520), (565, 520), (565, 400), (590, 400)],   # D18 -> CLK
    [(320, 350), (270, 350), (270, 530), (560, 530), (560, 390), (590, 390)],   # D19 -> DIN
    [(320, 410), (260, 410), (260, 540), (555, 540), (555, 420), (590, 420)],   # D2 -> DC
    [(320, 400), (255, 400), (255, 550), (550, 550), (550, 430), (590, 430)],   # D4 -> RST
    # UART to MAX485
    [(320, 390), (215, 390), (215, 210), (550, 210)],   # RX2 -> RO
    [(320, 380), (205, 380), (205, 180), (550, 180)],   # TX2 -> DI
    [(550, 200), (540, 200), (540, 190), (550, 190)],   # RE+DE
    [(540, 195), (520, 195), (520, 370), (460, 370)],   # -> D25
    # sensors
    [(460, 340), (490, 340), (490, 250), (530, 250), (530, 280), (560, 280)],   # D35 -> SENSOR_A
    [(460, 330), (475, 330), (475, 70), (230, 70), (230, 110)],                 # D34 -> R1.2
]
DOTS = [(250, 410), (210, 400), (485, 470), (160, 280), (500, 430), (300, 440), (540, 195), (410, 100)]
LABELS = [("GND", 692, 103), ("SENSOR_A", 535, 283), ("VIN", 253, 474)]

json.dump({"W": W, "H": H, "comps": COMPS, "wires": WIRES, "dots": DOTS, "labels": LABELS},
          open("demo.json", "w"))
open("../extension/lib/demo.js", "w").write("window.DEMO=" + json.dumps(
    {"W": W, "H": H, "comps": COMPS, "wires": WIRES, "dots": DOTS, "labels": LABELS}) + ";")

c = canvas.Canvas("./sample_schematic.pdf", pagesize=(W, H))
c.setTitle("Test schematic (ESP32 + sensors)")
WIRE, BODY, TEXT = (0.0, 0.52, 0.0), (0.55, 0.0, 0.0), (0.0, 0.0, 0.0)

c.setStrokeColorRGB(0, 0, 0); c.setLineWidth(0.5)
c.rect(20, 20, W - 40, H - 40); c.rect(W - 220, 20, 200, 50); c.line(W - 220, 45, W - 20, 45)
c.setFont("Helvetica", 7)
c.drawString(W - 215, 58, "TITLE: Test schematic (prototype)"); c.drawString(W - 215, 32, "Sheet 1/1   Rev 1.0")

for name, x, y, w, h, L, R, T, B in COMPS:
    c.setStrokeColorRGB(*BODY); c.setLineWidth(0.6); c.rect(x, y, w, h, stroke=1, fill=0)
    c.setFillColorRGB(*TEXT); c.setFont("Helvetica", 6); c.drawString(x, y + h + 3, name); c.setFont("Helvetica", 5)
    for i, l in enumerate(L):
        py = y + h - 10 - i * 10; c.line(x - 10, py, x, py); c.drawString(x + 2, py - 1.5, l)
    for i, l in enumerate(R):
        py = y + h - 10 - i * 10; c.line(x + w, py, x + w + 10, py); c.drawRightString(x + w - 2, py - 1.5, l)
    for i, l in enumerate(T):
        px = x + 10 + i * 12; c.line(px, y + h, px, y + h + 10); c.drawString(px + 1.5, y + h - 6, l)
    for i, l in enumerate(B):
        px = x + 10 + i * 12; c.line(px, y, px, y - 10); c.drawString(px + 1.5, y + 2, l)

c.setStrokeColorRGB(*WIRE); c.setLineWidth(0.7)
for pts in WIRES:
    p = c.beginPath(); p.moveTo(*pts[0])
    for x, y in pts[1:]:
        p.lineTo(x, y)
    c.drawPath(p, stroke=1, fill=0)
c.setFillColorRGB(*WIRE)
for x, y in DOTS:
    c.circle(x, y, 1.6, stroke=0, fill=1)
c.setFillColorRGB(*TEXT); c.setFont("Helvetica", 6)
for s, x, y in LABELS:
    c.drawString(x, y, s)
c.showPage(); c.save()
print("ok")
