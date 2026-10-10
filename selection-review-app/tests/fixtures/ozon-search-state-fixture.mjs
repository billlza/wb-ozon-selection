// A purely synthetic Ozon search grid state, shaped like the widget state Ozon writes into its search page
// (data-state on a state-searchResultsV2-… element). No real product, seller, price or tracking value.
export const SYNTHETIC_OZON_QUERY = "синтетический жилет для кошки";

const tile = (id, { name = `Синтетический жилет ${id}`, price = "1 299 ₽", original = "2 599 ₽", rating = "4.8", reviews = "1 234 отзыва",
  picture = `https://ir.ozone.ru/s3/multimedia-1-z/wc500/90000${id}.jpg`, label = null, wrapped = false, sku = undefined } = {}) => {
  const atoms = [
    { type: "priceV2", priceV2: { price: [{ text: price, textStyle: "PRICE" }, ...(original ? [{ text: original, textStyle: "ORIGINAL_PRICE" }] : [])],
      discount: "−50%" }, id: "atom" },
    { type: "textAtom", id: "name", textAtom: { text: name, textStyle: "tsBodyL", maxLines: 2 } },
    { type: "labelList", id: "labels", labelList: { items: [
      { icon: { image: "ic_s_star_filled_compact", tintColor: "graphicRating" }, title: `<b>${rating}</b>  ` },
      { icon: { image: "ic_s_dialog_filled_compact", tintColor: "graphicTertiary" }, title: reviews },
      ...(label ? [{ title: label }] : [])
    ] } }
  ];
  return {
    action: { behavior: "BEHAVIOR_TYPE_REDIRECT", link: `/product/sinteticheskiy-zhilet-90000${id}/?asb=SYNTHETIC&avtc=1&keywords=synthetic` },
    mainState: wrapped ? atoms.map(atom => ({ atom })) : atoms,
    tileImage: { items: [{ type: "image", image: { link: picture, contentMode: "SCALE_ASPECT_FIT" } }] },
    skuId: sku ?? `90000${id}`,
    trackingInfo: { click: { actionType: "click", key: "synthetic-tracking-key" } }
  };
};

export const SYNTHETIC_OZON_SEARCH_STATE = {
  items: [
    tile(101),
    tile(102, { price: "849 ₽", original: null, rating: "4.5", reviews: "57 отзывов", label: "Реклама" }),
    tile(103, { wrapped: true, price: "1 049,50 ₽", original: "1 999 ₽", reviews: "1 отзыв" }),
    tile(104, { picture: "https://cdn.example.com/not-ozon.jpg" }),
    tile(105, { sku: "9999999" })
  ],
  layoutTrackingInfo: { synthetic: true }
};

export const SYNTHETIC_OZON_SEARCH_HTML = [
  `<!-- saved from url=(0099)https://www.ozon.ru/search/?text=${encodeURIComponent(SYNTHETIC_OZON_QUERY).replace(/%20/g, "+")}&from_global=true -->`,
  "<html><head><title>синтетический жилет для кошки — купить на OZON</title></head><body>",
  `<div data-widget="searchResultsV2"><div id="state-searchResultsV2-000001-default-1" data-state="${
    JSON.stringify(SYNTHETIC_OZON_SEARCH_STATE).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></div>`,
  "<a href=\"/product/sinteticheskiy-zhilet-90000101/\">Синтетический жилет 90000101</a></div>",
  "</body></html>"
].join("\n");
