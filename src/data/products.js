// HoopBioPharma catalog data — 51 products across 6 categories,
// sourced from the live product listing at hoopbiopharma.com.

export const CATEGORIES = [
  { id: "growth-hormone",       name: "Growth Hormone",        var: "--cat-growth" },
  { id: "repair-skin",          name: "Repair & Skin",         var: "--cat-repair" },
  { id: "weight-management",    name: "Weight Management",     var: "--cat-weight" },
  { id: "cognitive-longevity",  name: "Cognitive & Longevity", var: "--cat-cognitive" },
  { id: "sexual-health",        name: "Sexual Health",         var: "--cat-sexual" },
  { id: "blends",               name: "Peptide Blends",        var: "--cat-blends-a" }
];

// Real per-product photography pulled directly from hoopbiopharma.com
// (public/images/products/<id>.webp — one distinct photo per SKU).
// IMG.* below is accepted by P() for backward-compat call sites but ignored —
// the per-id path below always wins since every SKU now has its own photo.
const IMG = { vial1: "", vial2: "", bacWater: "", group: "" };

// Short lowercase category taglines shown under each product name on cards
// (mirrors roehn.co's "regenerative peptide" / "cellular energy" pattern).
const CATEGORY_TAGLINE = {
  "growth-hormone": "growth axis research",
  "repair-skin": "regenerative & dermal peptide",
  "weight-management": "metabolic research",
  "cognitive-longevity": "cognitive & longevity research",
  "sexual-health": "sexual health research",
  "blends": "research blend"
};

function P(id, name, sku, conc, cat, desc, specs, price, image, isNew) {
  const sub = Math.round(price * 0.95 * 100) / 100;
  return {
    id, name, sku, concentration: conc, category: cat, description: desc,
    specifications: specs, price, subscribePrice: sub, save: price - sub,
    image: `/images/products/${id}.webp`, isNew: !!isNew,
    tagline: CATEGORY_TAGLINE[cat] || "research compound"
  };
}

export const PRODUCTS = [
  P("5a1mq-50mg","5-Amino-1MQ","5A1MQ-50MG","50mg","weight-management","5-Amino-1MQ is a small molecule inhibitor of NNMT (nicotinamide N-methyltransferase), an enzyme involved in cellular energy metabolism. Research suggests it may play a role in regulating fat cell metabolism and energy expenditure.",{"Molecular Formula":"C₁₁H₁₂N₂O","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},159,IMG.vial1),
  P("bac-water-10ml","BAC Water 10ml","BACWATER-10ML","10ml","growth-hormone","Bacteriostatic Water (BAC Water) is sterile water containing 0.9% benzyl alcohol as a bacteriostatic preservative, used for dilution and reconstitution of lyophilized peptides for research applications.",{"Volume":"10ml","Preservative":"0.9% Benzyl Alcohol","Sterility":"Sterile filtered","Storage":"Room temperature"},19,IMG.bacWater),
  P("bac-water-3ml","BAC Water 3ml","BACWATER-3ML","3ml","growth-hormone","Bacteriostatic Water (BAC Water) is sterile water containing 0.9% benzyl alcohol as a bacteriostatic preservative. Compact 3ml vial for smaller reconstitution volumes.",{"Volume":"3ml","Preservative":"0.9% Benzyl Alcohol","Sterility":"Sterile filtered","Storage":"Room temperature"},15,IMG.bacWater),
  P("bpc157-10mg","BPC-157","BPC157-10MG","10mg","repair-skin","BPC-157 (Body Protection Compound-157) is a pentadecapeptide composed of 15 amino acids, derived from a protective protein found in gastric juice. Research suggests potential applications in tissue repair, wound healing, and gastrointestinal protection.",{"Sequence":"Gly-Glu-Pro-Pro-Pro-Gly-Lys-Pro-Ala-Asp-Asp-Ala-Gly-Leu-Val","Molecular Weight":"1419.53 g/mol","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},141,IMG.vial1),
  P("bpc157-tb500-wolverine",'BPC-157/TB-500 "Wolverine"',"WOLVERINE-10MG10MG","10mg/10mg","blends",'The "Wolverine" blend combines BPC-157 and TB-500 (Thymosin Beta-4), two peptides extensively studied for tissue repair and recovery. Designed for research into synergistic effects on wound healing and tissue regeneration.',{"BPC-157 Content":"10mg","TB-500 Content":"10mg","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},200,IMG.group),
  P("cjc1295-dac-5mg","CJC-1295 w/ DAC","CJC1295DAC-5MG","5mg","growth-hormone","CJC-1295 with Drug Affinity Complex (DAC) is a synthetic analogue of growth hormone-releasing hormone (GHRH). The DAC modification extends its half-life, allowing for sustained research into growth hormone secretion patterns.",{"Molecular Weight":"3647.28 g/mol","Half-life":"Extended (with DAC)","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},178,IMG.vial2),
  P("cjc1295-no-dac-5mg","CJC-1295 w/o DAC","CJC1295-5MG","5mg","growth-hormone","CJC-1295 without DAC (also known as Modified GRF 1-29) is a synthetic GHRH analog. Without the DAC modification, it has a shorter half-life, useful for research into pulsatile growth hormone release patterns.",{"Molecular Weight":"3367.97 g/mol","Half-life":"Standard (without DAC)","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},165,IMG.vial2),
  P("cjc1295-ipamorelin-blend","CJC-1295/Ipamorelin Blend","CJCIPAM-5MG5MG","5mg/5mg","blends","This blend combines CJC-1295 (a GHRH analog) with Ipamorelin (a selective growth hormone secretagogue). Research investigates synergistic effects on growth hormone release through complementary mechanisms of action.",{"CJC-1295 Content":"5mg","Ipamorelin Content":"5mg","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},172,IMG.group),
  P("epithalon-50mg","Epithalon","EPITHALON-50MG","50mg","cognitive-longevity","Epithalon (Epitalon) is a synthetic tetrapeptide studied for its potential effects on telomerase activity. Research explores its role in cellular aging processes and telomere length maintenance.",{"Sequence":"Ala-Glu-Asp-Gly","Molecular Weight":"390.35 g/mol","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},138,IMG.vial2),
  P("ghk-cu-50mg","GHK-Cu","GHKCU-50MG","50mg","repair-skin","GHK-Cu (Copper Peptide) is a naturally occurring tripeptide-copper complex found in human plasma. Research focuses on its role in skin remodeling, wound healing, collagen synthesis, and antioxidant activity.",{"Molecular Weight":"403.93 g/mol","Metal Content":"Copper (Cu²⁺)","Appearance":"Blue lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},175,IMG.vial1),
  P("ghk-cu-100mg","GHK-Cu 100mg","GHKCU-100MG","100mg","repair-skin","GHK-Cu (Copper Peptide) in a higher concentration 100mg vial. Researched for skin remodeling, wound healing, and collagen synthesis.",{"Molecular Weight":"403.93 g/mol","Metal Content":"Copper (Cu²⁺)","Appearance":"Blue lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},299,IMG.vial1),
  P("glow-blend",'GHK-Cu/BPC-157/TB-500 "GLOW"',"GLOW-50MG10MG10MG","50mg/10mg/10mg","blends",'The "GLOW" blend combines GHK-Cu, BPC-157, and TB-500 for research into synergistic effects on tissue repair, skin rejuvenation, and wound healing through multiple complementary pathways.',{"GHK-Cu Content":"50mg","BPC-157 Content":"10mg","TB-500 Content":"10mg","Appearance":"Lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},290,IMG.group),
  P("klow-blend",'GHK-Cu/TB-500/BPC-157/KPV "KLOW"',"KLOW-50MG10MG10MG10MG","50mg/10mg/10mg/10mg","blends",'The "KLOW" blend is an advanced four-peptide combination of GHK-Cu, TB-500, BPC-157, and KPV. Research investigates combined effects on tissue repair, anti-inflammatory responses, and skin health.',{"GHK-Cu Content":"50mg","TB-500 Content":"10mg","BPC-157 Content":"10mg","KPV Content":"10mg","Appearance":"Lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},299,IMG.group,true),
  P("semaglutide-20mg","GLP-1sg (Semaglutide)","SEMA-20MG","20mg","weight-management","Semaglutide is a GLP-1 receptor agonist originally developed for glycemic control. Research investigates its effects on appetite regulation, energy balance, and metabolic processes through GLP-1 receptor activation.",{"Molecular Weight":"4113.58 g/mol","Type":"GLP-1 Receptor Agonist","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},239,IMG.vial2),
  P("glp2-100mg","GLP-2 (Tirzepatide) 100mg","GLP2-100MG","100mg","weight-management","Tirzepatide is a dual GIP/GLP-1 receptor agonist. Research explores its dual-action mechanism on glucose metabolism and appetite regulation through simultaneous activation of both incretin pathways.",{"Type":"Dual GIP/GLP-1 Receptor Agonist","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},599,IMG.vial2),
  P("glp2-10mg","GLP-2 (Tirzepatide) 10mg","GLP2-10MG","10mg","weight-management","Tirzepatide is a dual GIP/GLP-1 receptor agonist. Research explores its dual-action mechanism on glucose metabolism and appetite regulation through simultaneous activation of both incretin pathways.",{"Type":"Dual GIP/GLP-1 Receptor Agonist","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},189,IMG.vial2),
  P("glp2-30mg","GLP-2 (Tirzepatide) 30mg","GLP2-30MG","30mg","weight-management","Tirzepatide is a dual GIP/GLP-1 receptor agonist studied for metabolic research. This 30mg concentration provides flexibility for dose-response studies.",{"Type":"Dual GIP/GLP-1 Receptor Agonist","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},349,IMG.vial2),
  P("glp2-60mg","GLP-2 (Tirzepatide) 60mg","GLP2-60MG","60mg","weight-management","Tirzepatide is a dual GIP/GLP-1 receptor agonist. This 60mg concentration is designed for extended research protocols requiring higher dosing flexibility.",{"Type":"Dual GIP/GLP-1 Receptor Agonist","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},499,IMG.vial2),
  P("glp3-10mg","GLP-3 (Retatrutide) 10mg","GLP3-10MG","10mg","weight-management","Retatrutide is a triple-agonist peptide targeting GIP, GLP-1, and glucagon receptors simultaneously. Research investigates its multi-receptor approach to metabolic regulation and energy balance.",{"Type":"Triple GIP/GLP-1/Glucagon Receptor Agonist","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},254,IMG.vial1,true),
  P("glp3-30mg","GLP-3 (Retatrutide) 30mg","GLP3-30MG","30mg","weight-management","Retatrutide triple-agonist peptide in 30mg concentration for research applications.",{"Type":"Triple GIP/GLP-1/Glucagon Receptor Agonist","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},549,IMG.vial1,true),
  P("glp3-60mg","GLP-3 (Retatrutide) 60mg","GLP3-60MG","60mg","weight-management","Retatrutide triple-agonist peptide in the highest available concentration (60mg) for research.",{"Type":"Triple GIP/GLP-1/Glucagon Receptor Agonist","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},899,IMG.vial1,true),
  P("glp3-100mg","GLP-3 (Retatrutide) 100mg","GLP3-100MG","100mg","weight-management","Retatrutide triple-agonist peptide in the highest available concentration (100mg) for extended research protocols.",{"Type":"Triple GIP/GLP-1/Glucagon Receptor Agonist","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},211.99,IMG.vial1,true),
  P("gsh-1500mg","Glutathione","GSH-1500MG","1500mg","cognitive-longevity","Glutathione (GSH) is a tripeptide and the body's primary endogenous antioxidant. Research investigates its role in oxidative stress defense, detoxification pathways, and cellular health maintenance.",{"Molecular Weight":"307.32 g/mol","Sequence":"γ-Glu-Cys-Gly","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},139,IMG.vial2),
  P("hcg-10000iu","HCG","HCG-10000IU","10,000 IU","sexual-health","Human Chorionic Gonadotropin (HCG) is a glycoprotein hormone. Research applications include studies on gonadal function, reproductive physiology, and hormonal signaling pathways.",{"Activity":"10,000 IU","Type":"Glycoprotein Hormone","Appearance":"White lyophilized powder","Storage":"Store at 2–8°C","Purity":"≥99%"},129,IMG.vial2),
  P("ipamorelin-10mg","Ipamorelin","IPAM-10MG","10mg","growth-hormone","Ipamorelin is a selective growth hormone secretagogue peptide (GHSP). It stimulates growth hormone release through the ghrelin receptor with high selectivity, valuable for GH research without significant effects on cortisol or prolactin.",{"Molecular Weight":"711.85 g/mol","Sequence":"Aib-His-D-2-Nal-D-Phe-Lys-NH₂","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},155,IMG.vial2),
  P("kpv-10mg","KPV","KPV-10MG","10mg","repair-skin","KPV is a tripeptide derived from alpha-melanocyte-stimulating hormone (α-MSH). Research investigates its anti-inflammatory properties and potential applications in modulating immune responses.",{"Sequence":"Lys-Pro-Val","Molecular Weight":"342.43 g/mol","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},139,IMG.vial1),
  P("mots-c-10mg","MOTS-C","MOTS-C-10MG","10mg","cognitive-longevity","MOTS-C is a mitochondria-derived peptide encoded in the mitochondrial genome. Research explores its role in metabolic homeostasis, exercise physiology, and cellular energy regulation.",{"Type":"Mitochondria-derived peptide","Sequence":"16 amino acids","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},145,IMG.vial1),
  P("mots-c-40mg","MOTS-C 40mg","MOTS-C-40MG","40mg","cognitive-longevity","MOTS-C in a higher concentration 40mg vial. Researched for its role in mitochondrial metabolic homeostasis, exercise physiology, and cellular energy regulation, with extended dosing flexibility for research protocols.",{"Type":"Mitochondria-derived peptide","Sequence":"16 amino acids","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},80.99,IMG.vial1),
  P("mt2-10mg","Melanotan 2 (MT2)","MT2-10MG","10mg","repair-skin","Melanotan II is a synthetic analog of α-melanocyte-stimulating hormone (α-MSH). Research investigates its effects on melanogenesis (skin pigmentation) through melanocortin receptor activation.",{"Molecular Weight":"1024.18 g/mol","Type":"Melanocortin receptor agonist","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},99,IMG.vial2),
  P("nad-100mg","NAD+ 100mg","NAD-100MG","100mg","cognitive-longevity","NAD+ (Nicotinamide Adenine Dinucleotide) in 100mg concentration. Suitable for initial research protocols investigating cellular energy and repair pathways.",{"Molecular Weight":"663.43 g/mol","Content":"100mg","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},99,IMG.vial2),
  P("nad-500mg","NAD+ 500mg","NAD-500MG","500mg","cognitive-longevity","NAD+ (Nicotinamide Adenine Dinucleotide) in 500mg concentration. Mid-range concentration for sustained research into NAD+ metabolism and sirtuin pathways.",{"Molecular Weight":"663.43 g/mol","Content":"500mg","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},179,IMG.vial2),
  P("nad-1000mg","NAD+ 1000mg","NAD-1000MG","1000mg","cognitive-longevity","NAD+ (Nicotinamide Adenine Dinucleotide) in 1000mg concentration. The highest available dosing for extended research protocols investigating cellular energy metabolism and longevity pathways.",{"Molecular Weight":"663.43 g/mol","Content":"1000mg","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},249,IMG.vial2),
  P("pt141-10mg","PT-141","PT141-10MG","10mg","sexual-health","PT-141 (Bremelanotide) is a synthetic melanocortin peptide. Research investigates its action on the MC3R and MC4R receptors in the central nervous system, with studies focusing on sexual function and arousal pathways.",{"Molecular Weight":"1025.2 g/mol","Type":"Melanocortin receptor agonist","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},169,IMG.vial1),
  P("pinealon-10mg","Pinealon","PINEALON-10MG","10mg","cognitive-longevity","Pinealon is a tripeptide bioregulator studied for its effects on the central nervous system. Research focuses on its potential neuroprotective properties and influence on brain function and cognitive processes.",{"Sequence":"Glu-Asp-Arg","Type":"Peptide bioregulator","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},179,IMG.vial1),
  P("selank-10mg","Selank","SELANK-10MG","10mg","cognitive-longevity","Selank is a synthetic peptide analog of the immunomodulatory peptide tuftsin. Research investigates its anxiolytic properties, cognitive enhancement effects, and neuromodulatory activity without sedation.",{"Type":"Tuftsin analog","Sequence":"Thr-Lys-Pro-Arg-Pro-Gly-Pro","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},189,IMG.vial1),
  P("semax-10mg","Semax","SEMAX-10MG","10mg","cognitive-longevity","Semax is a synthetic peptide analog of ACTH (adrenocorticotropic hormone). Research focuses on its nootropic properties, neurotrophic factor modulation, and potential neuroprotective effects.",{"Sequence":"Met-Glu-His-Phe-Pro-Gly-Pro","Type":"ACTH analog","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},189,IMG.vial1),
  P("tb500-10mg","TB-500","TB500-10MG","10mg","repair-skin","TB-500 is a synthetic version of the naturally occurring peptide Thymosin Beta-4. Research focuses on its role in cell migration, blood vessel formation, and tissue repair processes through actin regulation.",{"Molecular Weight":"4963.5 g/mol","Type":"Thymosin Beta-4 fragment","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},142,IMG.vial1),
  P("tesamorelin-10mg","Tesamorelin","TESA-10MG","10mg","growth-hormone","Tesamorelin is a synthetic analog of growth hormone-releasing hormone (GHRH) with a trans-3-hexenoic acid modification. Research investigates its targeted effects on growth hormone release and visceral adipose tissue.",{"Molecular Weight":"5135.9 g/mol","Type":"Modified GHRH analog","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},169,IMG.vial2),
  P("tesamorelin-ipamorelin-blend","Tesamorelin/Ipamorelin Blend","TESAIPAM-12MG2MG","12mg/2mg","blends","This blend combines Tesamorelin (GHRH analog) with Ipamorelin (GH secretagogue) for research into synergistic growth hormone stimulation through dual-pathway activation.",{"Tesamorelin Content":"12mg","Ipamorelin Content":"2mg","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},219,IMG.group),
  P("ta1-10mg","Thymosin Alpha-1","TA1-10MG","10mg","cognitive-longevity","Thymosin Alpha-1 is a naturally occurring thymic peptide. Research investigates its immunomodulatory properties, including enhancement of T-cell function and dendritic cell activation.",{"Molecular Weight":"3108.3 g/mol","Sequence":"28 amino acids","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},189,IMG.vial1),
  // ---- Added to match the manufacturing price sheet (dosages/blends that
  // weren't yet in the catalog) ----
  P("ghk-cu-kpv-50mg","GHK-Cu/KPV Blend","GHKCUKPV-50MG","50mg","blends","This blend combines GHK-Cu (a copper peptide studied for skin remodeling and tissue repair) with KPV (a tripeptide studied for anti-inflammatory signaling), for research into combined regenerative and anti-inflammatory effects. 50mg combined peptide content.",{"Total Peptide Content":"50mg","Appearance":"Lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},54.99,IMG.group),
  P("retatrutide-carglintide-25mg5mg","Retatrutide/Carglintide Blend","RETACAGRI-25MG5MG","25mg/5mg","blends","This blend combines Retatrutide (a triple GIP/GLP-1/glucagon receptor agonist) with Cagrilintide (a long-acting amylin receptor agonist), for research into combined incretin and amylin pathway effects on appetite regulation and metabolic control.",{"Retatrutide Content":"25mg","Cagrilintide Content":"5mg","Appearance":"Lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},114.99,IMG.group,true),
  P("semax-selank-blend","Semax/Selank Blend","SEMAXSELANK-5MG5MG","5mg/5mg","blends","This blend combines Semax (an ACTH-fragment analog studied for nootropic and neurotrophic effects) with Selank (a tuftsin analog studied for anxiolytic and neuromodulatory activity), for research into combined cognitive and behavioral pathways.",{"Semax Content":"5mg","Selank Content":"5mg","Appearance":"Lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},76.99,IMG.group),
  P("cagrilintide-10mg","Cagrilintide","CAGRI-10MG","10mg","weight-management","Cagrilintide is a long-acting amylin receptor agonist studied for its effects on satiety and energy intake. Often researched alongside GLP-1 agonists for combined incretin/amylin pathway research into appetite regulation and metabolic control.",{"Type":"Long-acting Amylin Receptor Agonist","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},100.99,IMG.vial1),
  P("aod9604-5mg","AOD-9604","AOD9604-5MG","5mg","weight-management","AOD-9604 is a modified fragment of human growth hormone (hGH 176-191) studied for its role in lipid metabolism and fat breakdown, researched without the growth-promoting effects associated with full-length HGH.",{"Sequence":"HGH Fragment 176-191","Type":"Modified GH Fragment","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},60.99,IMG.vial2),
  P("dsip-10mg","DSIP","DSIP-10MG","10mg","cognitive-longevity","Delta Sleep-Inducing Peptide (DSIP) is a neuropeptide with research applications in sleep physiology. Studies investigate its role in promoting delta-wave sleep patterns and stress response modulation.",{"Sequence":"Trp-Ala-Gly-Gly-Asp-Ala-Ser-Gly-Glu","Molecular Weight":"848.81 g/mol","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},58.99,IMG.vial1),
  P("sermorelin-5mg","Sermorelin","SERM-5MG","5mg","growth-hormone","Sermorelin is a synthetic analog of growth hormone-releasing hormone (GHRH) consisting of the first 29 amino acids of GHRH. Research investigates its ability to stimulate natural growth hormone production and release.",{"Molecular Weight":"3357.93 g/mol","Sequence":"GHRH(1-29)NH₂","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},43.99,IMG.vial2),
  P("kisspeptin-10mg","Kisspeptin","KISS-10MG","10mg","sexual-health","Kisspeptin is a naturally occurring neuropeptide that activates the KISS1 receptor (GPR54) to stimulate gonadotropin-releasing hormone (GnRH) secretion. Research explores its central role in the reproductive endocrine axis, including studies on gonadotropin regulation and hormonal signaling pathways.",{"Sequence":"Tyr-Asn-Trp-Asn-Ser-Phe-Gly-Leu-Arg-Phe-NH₂","Molecular Weight":"1302.44 g/mol","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},54.99,IMG.vial1,true),
  P("ss31-10mg","SS-31","SS31-10MG","10mg","cognitive-longevity","SS-31 (elamipretide) is a mitochondria-targeted tetrapeptide studied for its ability to concentrate on the inner mitochondrial membrane and interact with cardiolipin. Research investigates its role in mitigating oxidative stress and supporting mitochondrial bioenergetics in cellular aging models.",{"Sequence":"D-Arg-Dmt-Lys-Phe-NH₂","Molecular Weight":"639.82 g/mol","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},69.99,IMG.vial2,true),
  P("ss31-50mg","SS-31 50mg","SS31-50MG","50mg","cognitive-longevity","SS-31 (elamipretide) is a mitochondria-targeted tetrapeptide studied for its ability to concentrate on the inner mitochondrial membrane and interact with cardiolipin. This higher 50mg concentration is designed for extended research protocols. Research investigates its role in mitigating oxidative stress and supporting mitochondrial bioenergetics in cellular aging models.",{"Sequence":"D-Arg-Dmt-Lys-Phe-NH₂","Molecular Weight":"639.82 g/mol","Appearance":"White lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},172,IMG.vial2,true),
  P("mots-ghk-kpv-blend","MOTS-C/GHK-Cu/KPV Blend","MOTSGHKKPV-40MG25MG20MG","40mg/25mg/20mg","blends","This blend combines MOTS-C (a mitochondria-derived peptide studied for metabolic homeostasis and cellular energy regulation) with GHK-Cu (a copper peptide studied for skin remodeling and tissue repair) and KPV (a tripeptide studied for anti-inflammatory signaling), for research into combined metabolic, regenerative, and anti-inflammatory pathways.",{"MOTS-C Content":"40mg","GHK-Cu Content":"25mg","KPV Content":"20mg","Appearance":"Lyophilized powder","Storage":"Store at 0°C","Purity":"≥99%"},168,IMG.group,true)
];

// ---------------------------------------------------------------------
// Manufacturing price sheet (Wholesale / Doctors / Retail), per product id.
// Source of truth for the three customer-type tiers wherever a SKU is
// covered here. Any product id not listed below falls back to the
// standard multiplier discount applied at render time in main.js.
// ---------------------------------------------------------------------
const TIER_PRICING = {
  "bpc157-10mg":                     { wholesale: 25, doctor: 41.25, retail: 100 },
  "tb500-10mg":                      { wholesale: 32.16, doctor: 48.24, retail: 128.64 },
  "bpc157-tb500-wolverine":          { wholesale: 50.5, doctor: 60.6, retail: 151.5 },
  "glow-blend":                      { wholesale: 53.6, doctor: 54.94, retail: 134 },
  "klow-blend":                      { wholesale: 54, doctor: 92.07, retail: 189 },
  "kpv-10mg":                        { wholesale: 26, doctor: 36.4, retail: 91 },
  "tesamorelin-10mg":                { wholesale: 50, doctor: 58, retail: 125 },
  "cjc1295-ipamorelin-blend":        { wholesale: 38.86, doctor: 58.29, retail: 155.44 },
  "cjc1295-no-dac-5mg":              { wholesale: 29, doctor: 43.5, retail: 87 },
  "cjc1295-dac-5mg":                 { wholesale: 34, doctor: 40.8, retail: 102 },
  "ipamorelin-10mg":                 { wholesale: 26, doctor: 39, retail: 91 },
  "tesamorelin-ipamorelin-blend":    { wholesale: 56, doctor: 58.8, retail: 140 },
  "nad-100mg":                       { wholesale: 18.5, doctor: 27.75, retail: 64.75 },
  "nad-500mg":                       { wholesale: 24.5, doctor: 36.75, retail: 85.75 },
  "nad-1000mg":                      { wholesale: 32.5, doctor: 55.25, retail: 113.75 },
  "mots-c-10mg":                     { wholesale: 26.5, doctor: 39.75, retail: 92.75 },
  "pt141-10mg":                      { wholesale: 26.5, doctor: 41.08, retail: 92.75 },
  "mt2-10mg":                        { wholesale: 22, doctor: 33, retail: 66 },
  "5a1mq-50mg":                      { wholesale: 32, doctor: 48, retail: 80 },
  "semaglutide-20mg":                { wholesale: 27, doctor: 40.5, retail: 81 },
  "glp3-10mg":                       { wholesale: 30, doctor: 51, retail: 159.6 },
  "glp3-30mg":                       { wholesale: 53.6, doctor: 80.4, retail: 182.24 },
  "glp3-60mg":                       { wholesale: 80.4, doctor: 137.48, retail: 201 },
  "glp2-10mg":                       { wholesale: 24.12, doctor: 53.06, retail: 103.72 },
  "glp2-30mg":                       { wholesale: 33.5, doctor: 154.1, retail: 167.5 },
  "glp2-60mg":                       { wholesale: 54, doctor: 189, retail: 202.5 },
  "glp2-100mg":                      { wholesale: 82, doctor: 200.49, retail: 246 },
  "hcg-10000iu":                     { wholesale: 40, doctor: 50, retail: 80 },
  "ghk-cu-50mg":                     { wholesale: 17, doctor: 25.5, retail: 68 },
  "ghk-cu-100mg":                    { wholesale: 25, doctor: 48.75, retail: 100 },
  "semax-10mg":                      { wholesale: 25.5, doctor: 28.31, retail: 63.75 },
  "selank-10mg":                     { wholesale: 25.5, doctor: 40.8, retail: 63.75 },
  "epithalon-50mg":                  { wholesale: 40, doctor: 58, retail: 100 },
  "pinealon-10mg":                   { wholesale: 23, doctor: 34.5, retail: 69 },
  "ta1-10mg":                        { wholesale: 36, doctor: 54, retail: 72 },
  "gsh-1500mg":                      { wholesale: 33.5, doctor: 50.25, retail: 97.15 },
  "bac-water-3ml":                   { wholesale: 5, doctor: 6.25, retail: 10 },
  "bac-water-10ml":                  { wholesale: 9, doctor: 11.25, retail: 15.3 },
  "ghk-cu-kpv-50mg":                 { wholesale: 30, doctor: 45, retail: 120 },
  "mots-c-40mg":                     { wholesale: 44, doctor: 61.6, retail: 143 },
  "glp3-100mg":                      { wholesale: 103, doctor: 190.55, retail: 242.05 },
  "retatrutide-carglintide-25mg5mg": { wholesale: 53, doctor: 106, retail: 164.3 },
  "semax-selank-blend":              { wholesale: 42, doctor: 63, retail: 105 },
  "cagrilintide-10mg":               { wholesale: 55, doctor: 82.5, retail: 145.75 },
  "aod9604-5mg":                     { wholesale: 33, doctor: 49.5, retail: 82.5 },
  "dsip-10mg":                       { wholesale: 32, doctor: 48, retail: 80 },
  "sermorelin-5mg":                  { wholesale: 24, doctor: 36, retail: 54 },
  "kisspeptin-10mg":                 { wholesale: 22.5,  doctor: 31.5,  retail: 54.99 },
  "ss31-10mg":                       { wholesale: 28.5,  doctor: 39.9,  retail: 69.99 },
  "ss31-50mg":                       { wholesale: 71,    doctor: 106,   retail: 172 },
  "mots-ghk-kpv-blend":              { wholesale: 84,    doctor: 113.4, retail: 168 }
};

function money(n) { return Math.round(n * 100) / 100; }

PRODUCTS.forEach((p) => {
  const tp = TIER_PRICING[p.id];
  if (!tp) return;
  p.tierPricing = tp;
  p.price = tp.retail;
  p.subscribePrice = money(tp.retail * 0.95);
  p.save = money(p.price - p.subscribePrice);
});

// ---------------------------------------------------------------------
// Product info PDF brochures (public/brochures/<key>.pdf), keyed by
// product id or, for multi-dosage families, the family id (fam-*) so one
// brochure covers every dosage of that peptide. A handful of source PDFs
// (MOTS-C/GHK-Cu/KPV triple blend, SLU-PP-332) don't have a matching
// catalog entry and are intentionally left unmapped.
// ---------------------------------------------------------------------
const BROCHURES = {
  "bpc157-10mg": "/brochures/bpc157-10mg.pdf",
  "tb500-10mg": "/brochures/tb500-10mg.pdf",
  "bpc157-tb500-wolverine": "/brochures/bpc157-tb500-wolverine.pdf",
  "glow-blend": "/brochures/glow-blend.pdf",
  "klow-blend": "/brochures/klow-blend.pdf",
  "ghk-cu-kpv-50mg": "/brochures/ghk-cu-kpv-50mg.pdf",
  "kpv-10mg": "/brochures/kpv-10mg.pdf",
  "tesamorelin-10mg": "/brochures/tesamorelin-10mg.pdf",
  "cjc1295-ipamorelin-blend": "/brochures/cjc1295-ipamorelin-blend.pdf",
  "cjc1295-no-dac-5mg": "/brochures/cjc1295-no-dac-5mg.pdf",
  "cjc1295-dac-5mg": "/brochures/cjc1295-dac-5mg.pdf",
  "ipamorelin-10mg": "/brochures/ipamorelin-10mg.pdf",
  "tesamorelin-ipamorelin-blend": "/brochures/tesamorelin-ipamorelin-blend.pdf",
  "fam-nad": "/brochures/fam-nad.pdf",
  "mots-c-10mg": "/brochures/mots-c.pdf",
  "mots-c-40mg": "/brochures/mots-c.pdf",
  "fam-mots-c": "/brochures/mots-c.pdf",
  "pt141-10mg": "/brochures/pt141-10mg.pdf",
  "mt2-10mg": "/brochures/mt2-10mg.pdf",
  "5a1mq-50mg": "/brochures/5a1mq-50mg.pdf",
  "semaglutide-20mg": "/brochures/semaglutide-20mg.pdf",
  "fam-glp2": "/brochures/fam-glp2.pdf",
  "fam-glp3": "/brochures/fam-glp3.pdf",
  "retatrutide-carglintide-25mg5mg": "/brochures/retatrutide-carglintide-25mg5mg.pdf",
  "hcg-10000iu": "/brochures/hcg-10000iu.pdf",
  "fam-ghk-cu": "/brochures/fam-ghk-cu.pdf",
  "epithalon-50mg": "/brochures/epithalon-50mg.pdf",
  "semax-10mg": "/brochures/semax-10mg.pdf",
  "selank-10mg": "/brochures/selank-10mg.pdf",
  "semax-selank-blend": "/brochures/semax-selank-blend.pdf",
  "pinealon-10mg": "/brochures/pinealon-10mg.pdf",
  "ta1-10mg": "/brochures/ta1-10mg.pdf",
  "gsh-1500mg": "/brochures/gsh-1500mg.pdf",
  "cagrilintide-10mg": "/brochures/cagrilintide-10mg.pdf",
  "aod9604-5mg": "/brochures/aod9604-5mg.pdf",
  "dsip-10mg": "/brochures/dsip-10mg.pdf",
  "sermorelin-5mg": "/brochures/sermorelin-5mg.pdf"
};

PRODUCTS.forEach((p) => {
  if (BROCHURES[p.id]) p.brochure = BROCHURES[p.id];
});

export const byId = {};
PRODUCTS.forEach((p) => { byId[p.id] = p; });

// Peptides sold under one name at multiple dosages get grouped into a single
// shop card with a dosage selector on the product page, instead of a
// separate card per strength. Members are listed lowest dose first.
// fam-5a1mq, fam-semaglutide, and fam-slupp332 were dropped when the
// dosages not covered by the manufacturing price sheet were removed —
// each left with zero or one surviving member, so those SKUs now stand
// alone instead of showing a single-option dose selector.
const FAMILIES = {
  "fam-ghk-cu":      { name: "GHK-Cu",                members: ["ghk-cu-50mg", "ghk-cu-100mg"] },
  "fam-glp2":        { name: "GLP-2 (Tirzepatide)",   members: ["glp2-10mg", "glp2-30mg", "glp2-60mg", "glp2-100mg"] },
  "fam-glp3":        { name: "GLP-3 (Retatrutide)",   members: ["glp3-10mg", "glp3-30mg", "glp3-60mg", "glp3-100mg"] },
  "fam-nad":         { name: "NAD+",                  members: ["nad-100mg", "nad-500mg", "nad-1000mg"] },
  "fam-bac-water":   { name: "BAC Water",              members: ["bac-water-3ml", "bac-water-10ml"] },
  "fam-mots-c":      { name: "MOTS-C",                 members: ["mots-c-10mg", "mots-c-40mg"] },
  "fam-ss31":        { name: "SS-31",                  members: ["ss31-10mg", "ss31-50mg"] }
};

// familyById: fam-id -> a display record shaped like a product (name, image,
// price, description, etc.) so it can be rendered by the same card/grid code
// as an individual SKU. Each member SKU is tagged with `.family` so its own
// product page can resolve back to the family it belongs to.
export const familyById = {};
Object.keys(FAMILIES).forEach((fid) => {
  const fam = FAMILIES[fid];
  const variants = fam.members.map((mid) => byId[mid]).filter(Boolean);
  if (!variants.length) return;
  variants.forEach((v) => { v.family = fid; });
  const lead = variants[0];
  // Only surface a family-level "from" tier price when every dosage in the
  // family is covered by the price sheet — otherwise fall back to the
  // standard multiplier applied to the lowest retail price at render time.
  const allTiered = variants.every((v) => v.tierPricing);
  familyById[fid] = {
    id: fid,
    isFamily: true,
    name: fam.name,
    category: lead.category,
    tagline: lead.tagline,
    description: lead.description,
    image: lead.image,
    isNew: variants.some((v) => v.isNew),
    price: Math.min(...variants.map((v) => v.price)),
    tierPricing: allTiered ? {
      wholesale: Math.min(...variants.map((v) => v.tierPricing.wholesale)),
      doctor: Math.min(...variants.map((v) => v.tierPricing.doctor)),
      retail: Math.min(...variants.map((v) => v.tierPricing.retail))
    } : undefined,
    specifications: lead.specifications,
    variantIds: variants.map((v) => v.id),
    variantCount: variants.length,
    brochure: BROCHURES[fid]
  };
});

// Shop/grid display list: every product NOT part of a family, plus one
// grouped card per family — this is what the shop grid, home "featured"
// rail, and "related products" sections should iterate over.
export const SHOP_ITEMS = [
  ...PRODUCTS.filter((p) => !p.family),
  ...Object.values(familyById)
];

// Resolve a specific SKU id (or a family id) to the display item it should
// render as — the family record if the SKU belongs to one, else itself.
export function displayItem(id) {
  if (familyById[id]) return familyById[id];
  const p = byId[id];
  if (!p) return null;
  return p.family ? familyById[p.family] : p;
}

export function catInfo(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
}
export function catCount(id) {
  return PRODUCTS.filter((p) => p.category === id).length;
}
export function fmt(n) {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
