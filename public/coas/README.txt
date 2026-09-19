Certificates of Analysis (COA) — how to publish one

1. Drop the certificate PDF into this folder (public/coas/).
   Suggested naming: <product-id>.pdf — e.g. bpc157-10mg.pdf
   (Product ids are the same ids used in the product URLs, like
   /shop/bpc157-10mg — check src/data/products.js if you're unsure of
   an id.)

2. Open src/main.js and find the COA_AVAILABLE object (search for
   "COA_AVAILABLE"). Add one line per certificate:

     const COA_AVAILABLE = {
       "bpc157-10mg": "/coas/bpc157-10mg.pdf",
     };

3. Save, rebuild (npm run build) or just refresh your dev server —
   that product's row on the Certificates of Analysis page will now
   show a "View COA" link instead of "Pending upload."

Any product not listed in COA_AVAILABLE shows "Pending upload"
automatically, so it's safe to add these one at a time.
