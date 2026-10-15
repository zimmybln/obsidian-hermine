


### Achseneigenschaften

Achsen können folgende Eigenschaften definieren:
1. Vordefinierte Werte
2. Eigenschaft des Dokumentes, die hier verwendet und gesetzt werden soll
3. Anzeige als Axeneigenschaft
4. Nur-Lesen: Dann lassen sich Karten auf dieser Achse nicht verschieben


```hermione
...
y-werte: Nicht wichtig, mittel wichtig, wichtig, dringlich
y-achse: Dringlichkeit
y-label: Dringlichkeit
y-readonly: true
...

```

5. Achsenwerte


Eingabe	Erzeugte Werte
[0..100, Step 10]	0, 10, 20, 30, ..., 100
[1..5]	1, 2, 3, 4, 5 (Step 1 als Standard)
[-10..10, Step 5]	-10, -5, 0, 5, 10
[100..0, Step 25]	100, 75, 50, 25, 0 (absteigend)
[0.0..1.0, Step 0.2]	0, 0.2, 0.4, 0.6, 0.8, 1.0
Rot, Gelb, Grün	Rot, Gelb, Grün (wie bisher)


source: "Projekte"
x-achse: Status
y-achse: Priorität
hide-unassigned: true

Verwendung:

Die filter-Option erhält ein Array aller Dokumente. Jedes Dokument hat eine properties-Map mit allen Frontmatter-Eigenschaften — unabhängig davon, ob sie auf einer Achse angezeigt werden.


source: Projekte
x-achse: Status
y-achse: Priorität
filter: (docs) => docs.filter(d => d.properties.aktiv === true)
Weitere Beispiele:


filter: (docs) => docs.filter(d => d.properties.punkte > 10)

filter: (docs) => docs.filter(d => d.name.startsWith("2024"))
Jedes Dokument-Objekt hat folgende Felder: file (TFile), path, name und properties (alle Frontmatter-Eigenschaften als Key-Value-Paare).


row-height: flexible | static

Die Von...Bis Range-Card-Funktion wurde implementiert. Hier eine Zusammenfassung der Änderungen:

Neue Konfigurationsoptionen

source: Projekte
x-achse: StartDatum
x-bis: EndDatum
y-achse: Priorität
Parser-Schlüssel:

x-bis / x-end / xbis / xend / x-axis-end → Endwert der X-Achse
y-bis / y-end / ybis / yend / y-axis-end → Endwert der Y-Achse

Geänderte Dateien
types.ts — xAxisEnd und yAxisEnd zum HermioneConfig hinzugefügt
parser.ts — Neue Parser-Einträge für die Range-End-Schlüssel
matrix-renderer.ts — Umfangreiche Änderungen:

Range-Dokumente werden vom normalen Rendering getrennt
renderRangeCards() — platziert Karten direkt im CSS-Grid mit grid-column/grid-row-Spanning
renderSingleAxisRangeCards() — dasselbe für Single-Axis-Boards
setupResizeHandle() — Maus-basierte Resize-Interaktion an den Rändern
calculateCellPositions() / findClosestCellIndex() — Berechnung der Zellpositionen für Snapping
updateRangePreview() — Visuelle Vorschau während des Resizens
styles.css — Range-Card-Styles:
Vertikale Karten mit 90°-gedrehtem Text (writing-mode: vertical-rl)
Resize-Handles an allen Rändern (links/rechts für X, oben/unten für Y)
Glass-Theme-Varianten für Range-Cards
Funktionsweise
Karten mit Von...Bis-Eigenschaft spannen über mehrere Zellen auf der jeweiligen Achse
An beiden Rändern erscheinen beim Hover Resize-Handles
Durch Ziehen der Handles wird der Start- oder Endwert aktualisiert und ins Frontmatter geschrieben
Transform-Support funktioniert auch für Range-Endwerte
Alle bestehenden Card-Styles (card-style) werden angewendet
Vertikale Range-Karten zeigen den Text um 90° gedreht an
## Themen-Slider (`hermione-topic`)

Ein Codeblock mit der Sprachkennung `hermione-topic` zeigt einen interaktiven Slider an.
Der eingestellte Wert wird beim Loslassen als `wert:` in den Codeblock zurückgeschrieben.

```hermione-topic
titel: Zufriedenheit
skala: direkt
min: 0
max: 100
schritte: 10
wert: 40
```

| Eigenschaft | Aliase | Bedeutung |
|---|---|---|
| `skala` | `scale` | Art der Skalenfestlegung. Bisher: `direkt` (Standard) |
| `min` | `minimum` | Minimalwert (Pflicht) |
| `max` | `maximum` | Maximalwert (Pflicht) |
| `schritte` | `steps`, `zwischenschritte` | Anzahl der Intervalle zwischen min und max (`0..100` mit `10` → 0, 10, …, 100). Ohne Angabe: stufenlos |
| `wert` | `value` | Aktueller Wert (wird vom Slider gesetzt) |
| `titel`, `beschreibung` | `title`, `description` | Optionale Überschrift und Beschreibung |
