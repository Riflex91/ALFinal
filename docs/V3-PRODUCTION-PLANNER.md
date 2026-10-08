# Produktionsplaner aus v3 in ALFinal

Entwicklungsstand vom 8. Oktober 2026. Noch keine Stable-Promotion oder Live-Abnahme.

## Umfang

`src/production-planner.js` portiert den `MerchantProductionPlanner` aus
`Riflex91-Repo/v3/src/merchant/merchant-production-planner.js`, Quellcommit
`43bcdee99ab12a92f7cbf8e7bcdac8f0e99983f2`.

Der Build lädt ihn nach ALFinals Gear-Bewertung. Er verwendet deren Klassen-/Rollenbewertung
und Slots, insbesondere `coat` statt eines inkompatiblen `chest`-Slots.
Der ExchangeCraftController stellt die Verbindung zu aktuellen Spiel-, Inventar-, Bank-
und accountweiten Charakterdaten her. Die bestehenden Exchange-/Craft-APIs bleiben kompatibel.

Übernommen beziehungsweise angepasst sind:

- rekursive Materialplanung mit Tiefen-, Zyklus-, Mengen- und Arbeitsbegrenzung;
- vorhandener Bestand vor Bankentnahme und kostenabhängiger Wahl zwischen NPC-Kauf und Craft;
- Upgrade-/Compound-Bedarf für Zutaten mit höherem Level;
- Farmbedarf für nicht beschaffbare Blattmaterialien;
- Gear-Empfehlungen für bekannte aktive und offline Charaktere;
- Schutz konkreter Itemeigenschaften und Berücksichtigung von Mengenreservierungen;
- NPC-Exchange- und Anniversary-Consolidation-Planung im internen Planer;
- Preis-/Goldreservegrenzen und ausdrückliches Quest-/Event-Opt-in.

Der originale Planer besitzt **keine Action Authority**. Das gilt auch für diese Portierung.
Ein Plan erzeugt keine Bewegung, Farmaufträge, Käufe, Mutationen oder Itemtransfers.
`reservations` beschreibt den Materialbedarf des Plans; es registriert keine neue Sperre
und ersetzt nicht die Reservierungen der ausführenden Controller.

## Öffentliche API

### Ein bestimmtes Item planen

```javascript
const graph = ALBot.exchangeCraft.productionGraph("cocoon", 1, {
  includeBank: true
});
show_json(graph);
```

`quantity` ist die zusätzlich zu produzierende Ausgabemenge, eine positive ganze Zahl.
Rezept-Outputmengen werden berücksichtigt: Liefert ein Craft drei Stück, werden für
vier angeforderte Stück zwei Crafts geplant. Die Begrenzung kann diese Überproduktion
ebenfalls ablehnen.

Wichtige Ergebnisfelder:

| Feld | Bedeutung |
|---|---|
| `state` | `READY`: Beschaffungskette planbar; `BLOCKED`: fehlende Materialien, Mutation oder struktureller Blocker; `HOLD`: Voraussetzungen fehlen |
| `steps` | Beschaffungs-/Produktionsschritte in Abhängigkeitsreihenfolge |
| `nextStep` | Nächste geplante Voraussetzung; bei strukturellen Blockern oder führendem Farmbedarf `null` |
| `blockers` | Fehlende Materialien, Mutation, Schutz-/Opt-in-, Gold- oder Begrenzungsprobleme |
| `reservations` | Geplanter Materialverbrauch nach `name\|level` |
| `totalGold` | Summe der konkret geplanten Kauf-/Craftkosten; keine garantierte Gesamtkostenschätzung für zufällige Mutationen/Farm-/Exchange-Ergebnisse |
| `bankKnowledge` | `LIVE_BANK`, `UNAVAILABLE` oder ausdrücklich `EXCLUDED` |
| `actionAuthority`, `liveExecutionAllowed` | Immer `false` |

Schrittarten umfassen `BANK_RETRIEVE`, `BUY`, `CRAFT`, `UPGRADE_REQUIRED`,
`COMPOUND_REQUIRED` und `FARM_REQUIRED`. Der interne Exchange-Planer ergänzt `EXCHANGE`.

Die Menge in einem `BANK_RETRIEVE`-Schritt beschreibt einen ganzen physischen Stack.
ALFinals H12-Reservierungen und Pack-/Map-Prüfungen bestimmen, ob dieser Stack verwendbar ist.
Ein geschützter beziehungsweise nicht entnehmbarer Stack wird nicht als freies Material gezählt.

`bankKnowledge: "UNAVAILABLE"` bedeutet ausdrücklich **nicht**, dass die Bank leer ist.
Vor einer Beschaffungsentscheidung muss der ausführende Ablauf den Bankbestand beobachten.
Ein `READY`-Plan ist keine Live-Autorisierung; insbesondere darf ein `BUY`-Vorschlag bei
unbekanntem Bankbestand nicht automatisch als beste accountweite Quelle ausgeführt werden.

### Gear-Ziele empfehlen

```javascript
const recommendation = ALBot.exchangeCraft.productionGear({
  targets: ["cocoon"],
  minImprovementRatio: 0.05,
  includeBank: true
});
show_json(recommendation);
```

Ohne `targets` werden craftbare Gear-Ziele innerhalb eines begrenzten Kandidatenscans
bewertet. Eine nicht bekannte beziehungsweise leere Ausrüstung wird nicht als sichere
Nullausrüstung angenommen. Waffen-/Offhand-Eignung wird anhand der Klassenregeln geprüft.
Offlineprofile kommen aus ALFinals bestehender Account Strategy; externe oder frei erfundene
Profile werden durch diese öffentliche API nicht eingespeist.

### Bestehende Produktionsvorschau

```javascript
const preview = ALBot.exchangeCraft.production("cocoon", 1);
show_json(preview.acquisition);
```

Die bisherigen Felder `stages`, `missing`, `totalCraftGold` und deren H16-Semantik bleiben
erhalten. Das zusätzliche Feld `acquisition` enthält den erweiterten v3-Graphen. Ein
vollständiger Beschaffungsablauf muss diesen Graphen und seine Blocker berücksichtigen;
die ältere H16-Ansicht allein bewertet beispielsweise keine vollständige Level-Mutationskette.

## Ausführung und klare Grenze zur v3-Autonomie

ALFinal besitzt bereits H12 Bank, H13 Trade, H15 Upgrade/Compound, H16 Exchange/Craft,
H17 Economy und Party Logistics. Deren Queue-, Ownership-, STOP-, Settlement- und
Revalidation-Regeln bleiben unverändert. Diese Portierung startet keinen parallelen
Executor und deaktiviert keine Schutzprüfung.

Der separate v3-`merchant-production-controller.js` wurde **nicht** importiert. Er enthält
unter anderem persistente Production Intents, gemeinsame Material-Farmaufträge,
P90-Beschaffungsplanung, Quest-/Event-Acquisition und Lieferabschluss beim Empfänger.
Diese Funktionen sind nicht allein durch Import des Planers automatisch aktiv.
Der Planner-Status weist deshalb P90-Farmplanung nicht fälschlich als implementiert aus.

Auch eine `UPGRADE_REQUIRED`-/`COMPOUND_REQUIRED`-Empfehlung umgeht nicht die vorhandene
ALFinal-Gear-Policy: H15 kann eine solche Materialmutation derzeit weiterhin ablehnen,
wenn sie nicht zu seiner freigegebenen Gear-/Wirtschaftsentscheidung passt.

## Validierung und Release

Die Regressionen prüfen Kostenwahl, Outputmengen, Bank-/Itemschutz, Reservierungen,
Mutationstypen, rekursive Farm-Blattmaterialien, Zyklen, Limits, bekannte Gearprofile,
Input-Unveränderlichkeit und die read-only API-Anbindung. Bestehende H16-Regressionsfälle
prüfen weiterhin Dispatch und UNKNOWN-/Settlement-Verhalten.

Der Stable-Pointer in `release/al-bot-release.json` bleibt auf dem bisherigen Release.
Ein lokal neu gebauter Kandidat wird nicht durch den normalen Bootstrap automatisch geladen.
Lokale Codex-Prüfungen sind Entwicklungsdiagnostik und keine Release-Freigabe.

Für eine spätere Abnahme reichen gezielte Live-Beobachtungen der Graphen für ein
Bankmaterial, ein Kaufmaterial, eine Levelzutat und eine Gear-Empfehlung. Die Planung
selbst löst dabei keine Spielaktionen aus. Eine automatische Ende-zu-Ende-Produktion
benötigt ihre eigene Controller-Integration und Live-Abnahme.
