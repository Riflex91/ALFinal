# AL Bot

**Repository:** `Riflex91/ALFinal`

AL Bot ist die finale, neu aufgebaute Adventure-Land-Bot-Codebasis. Intern darf die Entwicklungsgeneration als „V6“ bezeichnet werden. **Im Produkt, in der GUI, im normalen Code und in der Projektdokumentation heißt das System jedoch nur `AL Bot`.**

## Verbindliche Projektziele

1. **Zuverlässigkeit hat oberste Priorität.**
2. **Modulare Architektur**, damit Funktionen später ergänzt, ersetzt oder geändert werden können.
3. **Headless-Fähigkeit von Anfang an** – die GUI darf niemals Voraussetzung für den Bot-Core sein.
4. Eine **mitwachsende Haupt-GUI / Control Center** wird bereits im Fundament angelegt.
5. Ein **Prioritäten- und Goal-System** ist Kernbestandteil der Architektur.
6. Der Bot kann die von der bestehenden **Windows Bridge** bereitgestellte Adventure-Land-Wissensdatenbank über eine klar getrennte, read-only Knowledge-Schicht nutzen.
7. Entwicklung erfolgt in **kleinen, direkt im echten Spiel testbaren Häppchen**.
8. Die langen V5-Testketten `Shadow → Evidence → Authorization → One-shot → 5m → 15m` sind **kein Pflichtprozess** für AL Bot.
9. Stattdessen besitzt der Bot von Anfang an einen permanent sichtbaren **roten globalen STOP-Button**.

## Verbindliche Dokumente

- [Projektarchitektur und Grundsätze](docs/PROJECT-CHARTER.md)
- [Entwicklungsroadmap und Live-Test-Häppchen](docs/ROADMAP.md)
- [Chat-Handoff / aktueller Stand](docs/CHAT-HANDOFF.md)

## Aktueller Stand

- Architektur: **abgesprochen und freigegeben**
- Roadmap: **abgesprochen und freigegeben**
- Prioritäten-/Goal-System: **abgesprochen und freigegeben**
- Bot-Implementierung: **noch nicht begonnen**
- Nächster Entwicklungsschritt: **H1 / PR1 – AL Bot Foundation & Control Center**

Ein neuer Chat soll vor Änderungen zuerst die drei Dokumente unter `docs/` lesen und sie als verbindlichen Projektkontext behandeln.
