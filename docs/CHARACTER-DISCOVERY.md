# AL Bot – Dynamische Charakter- und Farmer-Erkennung

Stand: 2026-09-26

## Verbindliche Regel

AL Bot darf für den normalen Betrieb **keine hartcodierten Charakternamen benötigen**.

Der Bot erkennt die eigenen aktuell laufenden Charaktere dynamisch und leitet ihre Rollen aus den Adventure-Land-Daten ab.

## Adventure-Land-Quellen

Bevorzugte Kombination:

1. `get_characters()`
   - Account-eigene Charaktere
   - Klassen-/Typ-Metadaten
   - Online-Informationen

2. `get_active_characters()`
   - aktuell laufende Character-Runner
   - dient insbesondere als Liveness-/Aktivitätsquelle

3. lokaler `character`
   - garantiert mindestens die Identität des aktuellen Runners

Es werden ausschließlich Namen akzeptiert, die Adventure Land selbst für den eigenen Account bzw. als aktive Runner meldet. Namen werden nicht erfunden.

## Rollen

Aktive Charaktere der Combat-Klassen werden standardmäßig als Farmer erkannt:

- warrior
- paladin
- rogue
- ranger
- mage
- priest

Ein aktiver Charakter der Klasse `merchant` wird als Merchant erkannt.

Spätere explizite Rollen-/Task-Overrides dürfen möglich sein, aber nur als optionale Benutzerkonfiguration. Sie dürfen niemals Voraussetzung dafür sein, dass AL Bot die eingeloggten Farmer findet.

## Core-Schnittstelle

Bereits ab H1 stellt AL Bot eine abstrakte Roster-Schnittstelle bereit:

```text
ALBot.roster.status()
ALBot.roster.refresh()
ALBot.roster.farmers()
ALBot.roster.merchant()
```

Spätere Combat-, Party-, Logistics- und Economy-Module müssen diese dynamische Roster-Schicht verwenden und dürfen keine eigenen festen Namenslisten einführen.

## Zuverlässigkeitsregel

Wenn Account-/Klassenmetadaten vorübergehend nicht verfügbar sind:
- AL Bot darf keine unbekannten Namen erfinden;
- vorhandene sichere Live-Daten dürfen als begrenzter Fallback dienen;
- unklare Rollen bleiben unbekannt, statt falsch klassifiziert zu werden;
- die fehlende Information muss diagnostizierbar sein.

Die robuste Adventure-Land-Adapter-Integration wird in H3 weiter ausgebaut.
