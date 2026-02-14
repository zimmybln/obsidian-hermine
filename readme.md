


### Achseneigenschaften

Achsen können folgende Eigenschaften definieren:
1. Vordefinierte Werte
2. Eigenschaft des Dokumentes, die hier verwendet und gesetzt werden soll
3. Anzeige als Axeneigenschaft
4. Nur-Lesen: Dann lassen sich Karten auf dieser Achse nicht verschieben


```hermine
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


