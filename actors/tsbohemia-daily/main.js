import Apify from "apify";
import { Session } from "apify/build/session_pool/session.js";
import { PlaywrightPlugin, PuppeteerPlugin } from "browser-pool";
import FingerprintGenerator from "fingerprint-generator";
import { FingerprintInjector } from "fingerprint-injector";
import playwright from "playwright";
import cheerio from "cheerio";
import { gotScraping } from "got-scraping";
import { S3Client } from "@aws-sdk/client-s3";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { ActorType } from "@hlidac-shopu/actors-common/actor-type.js";
import { uploadToKeboola } from "@hlidac-shopu/actors-common/keboola.js";
import rollbar from "@hlidac-shopu/actors-common/rollbar.js";
import {
  invalidateCDN,
  uploadToS3v2
} from "@hlidac-shopu/actors-common/product.js";
import { getCheerioObject } from "./scraper.js";
import { BASE_URL, LABELS } from "./src/const.js";
import { getRandomInt } from "./src/utils.js";
import { CaptchaSolver } from "./src/captcha-solver.js";

const { log } = Apify.utils;
let stats = {
  categories: 0,
  pages: 0,
  pagination: 0,
  items: 0,
  itemsSkipped: 0,
  itemsDuplicity: 0,
  failed: 0
};
const processedIds = new Set();

Apify.main(async function main() {
  rollbar.init();

  const s3 = new S3Client({ region: "eu-central-1", maxAttempts: 3 });
  const cloudfront = new CloudFrontClient({
    region: "eu-central-1",
    maxAttempts: 3
  });

  log.info("ACTOR - Start");
  const input = await Apify.getInput();
  const {
    development = false,
    debug = false,
    maxRequestRetries = 3,
    maxConcurrency = 6,
    proxyGroups = ["CZECH_LUMINATI"],
    type = ActorType.FULL,
    feedUrl = ""
  } = input ?? {};

  log.info(`ACTOR - input: ${JSON.stringify(input)}`);
  const requestQueue = await Apify.openRequestQueue();

  let requestListSources = [];
  if (type === ActorType.BF) {
    await requestQueue.addRequest({
      userData: { label: LABELS.BF },
      url: "https://www.tsbohemia.cz/-black-friday_c41438.html"
    });
  } else if (type === LABELS.PRICE) {
    const response = await gotScraping({
      url: feedUrl
    });
    const { statusCode, body } = response;
    if (statusCode !== 200) {
      log.info(body.toString());
      throw new Error("Session blocked, retiring.");
    }
    const ids = body.toString().replace(/"/g, "").split("\n").slice(1);
    const uploadBatchSize = 24;
    let pushedItemsCount = 0;

    for (let i = pushedItemsCount; i < ids.length; i += uploadBatchSize) {
      const start = i;
      const end = i + uploadBatchSize;
      const itemsToPush = ids.slice(start, end);

      await requestQueue.addRequest({
        url: "https://www.tsbohemia.cz/TsbStoitemPriceList_jx.asp",
        userData: {
          label: LABELS.PRICE,
          ids: itemsToPush
        },
        uniqueKey: Math.random().toString()
      });
      log.info(`Pushing ${itemsToPush.length} from index ${start} to ${end}`);
    }
  } else if (type === ActorType.TEST) {
    await requestQueue.addRequest({
      url: "https://www.tsbohemia.cz/elektronika-televize_c5622.html",
      userData: {
        label: LABELS.PAGE,
        strid: 5622
      }
    });
  } else {
    await requestQueue.addRequest({
      url: "https://www.tsbohemia.cz/",
      userData: {
        label: LABELS.START
      }
    });
  }
  const requestList = await Apify.openRequestList("LIST", requestListSources);
  // Handle page context
  const handlePageFunction = async ({ page, request }) => {
    log.info(
      `Handling page ${request.url} with label ${request.userData.label}`
    );
    const content = await page.content();
    const $ = cheerio.load(content);
    // This is the start page
    if (request.userData.label === LABELS.START) {
      const categoryIds = [];

      $("a[data-strid]").each(function () {
        categoryIds.push({
          id: $(this).attr("data-strid"),
          name: $(this).text()
        });
      });

      for (const category of categoryIds) {
        const responseCheerio = await getCheerioObject(
          {
            url: `https://www.tsbohemia.cz/default_jx.asp?show=sptnavigator&strid=${category.id}`
          },
          proxyConfiguration
        );
        responseCheerio(".level6 > li > a").each(async function () {
          stats.categories++;
          const subCatUrl = `${BASE_URL}${responseCheerio(this).attr("href")}`;
          const finalUrl =
            subCatUrl.indexOf("https") === -1
              ? `https://www.tsbohemia.cz/${subCatUrl}`
              : subCatUrl;
          const subCategoryId = finalUrl.match("_c(.*).html")[1];
          await requestQueue.addRequest({
            url: `${finalUrl}`,
            userData: {
              label: LABELS.PAGE,
              categoryName: category.name,
              strid: subCategoryId
            },
            uniqueKey: Math.random().toString()
          });
        });
      }
    } else if (request.userData.label === LABELS.BF) {
      log.info("START BLACK FRIDAY");
      const categories = [];
      const tcs = $("ul.level9 a");
      for (let i = 0; i < tcs.length; i++) {
        const link = tcs[i];
        categories.push($(link).attr("href"));
      }
      stats.categories += categories.length;
      // Enqueue category links
      for (const cat of categories) {
        log.info(`Adding to the queue ${cat}`);
        await requestQueue.addRequest({
          url:
            cat.indexOf("https") === -1
              ? `https://www.tsbohemia.cz${cat}`
              : cat,
          userData: {
            label: LABELS.PAGE,
            name: "BF"
          }
        });
      }
    }

    // This is the category page
    else if (request.userData.label === LABELS.PAGE) {
      // Check for subcategories
      const subcategories = $("div.strcont > div.subcats").find("a");
      if (subcategories.length > 0) {
        for (const subcat of subcategories) {
          const link = $(subcat).attr("href");
          console.log(`${BASE_URL}${link}`);
          await requestQueue.addRequest({
            url: `${BASE_URL}${link}`,
            userData: {
              label: LABELS.PAGE
            }
          });
        }
        log.info(`Adding to the queue ${subcategories.length} subcategories`);
      } else if (
        !request.url.includes("page") &&
        $("p.reccount").length !== 0
      ) {
        // Enqueue pagination pages
        try {
          const paginationCount = Math.ceil(
            parseInt($("p.reccount").first().text()) / 24
          );
          for (let i = 2; i <= paginationCount; i++) {
            await requestQueue.addRequest(
              {
                url: `${request.url}?page=${i}#prodlistanchor`,
                userData: {
                  label: LABELS.PAGE,
                  name: request.userData.name
                },
                uniqueKey: Math.random().toString()
              },
              { forefront: true }
            );
          }
          log.info(`Adding to the queue ${paginationCount - 1} pagination`);
          stats.pagination += paginationCount;
        } catch (e) {
          log.error(e.message);
        }
      }

      const products = [];
      const toNumber = p => p.replace(/\s/g, "").match(/\d+/)[0];
      const navbar = $(".navbar ul > li");
      const category = [];
      if (navbar.length !== 0) {
        navbar.each(function () {
          const bs = $(this);
          if (!bs.hasClass("hp")) {
            category.push(bs.text().trim());
          }
        });
      }
      $(".prodbox").each(function () {
        try {
          const itemId = $(this).attr("data-stiid");
          const oPriceElem = $(this).find(".price .mc");
          const img = $(this).find(".img img").first().attr("data-src");
          const link = `https://www.tsbohemia.cz/${$(this)
            .find("h2 a")
            .first()
            .attr("href")}`;
          const name = $(this).find("h2 a").first().text().trim();
          const price = $(this).find(".price .wvat").first().text().trim();
          const dataItem = {
            img,
            itemId,
            itemUrl: link,
            itemName: name,
            discounted: false,
            currentPrice: price ? parseFloat(toNumber(price)) : null,
            category,
            menuCat: request.userData.name
          };
          if (oPriceElem.length !== 0) {
            const oPrice = oPriceElem.text().trim();
            dataItem.originalPrice = parseFloat(toNumber(oPrice));
            dataItem.discounted = true;
          }

          // Save data to dataset
          products.push(dataItem);
        } catch (e) {
          log.error(e);
        }
      });

      // we don't need to block pushes, we will await them all at the end
      const requests = [];
      for (const product of products) {
        // Save data to dataset
        if (!processedIds.has(product.itemId)) {
          processedIds.add(product.itemId);
          requests.push(
            Apify.pushData(product),
            uploadToS3v2(s3, product, { priceCurrency: "CZK" })
          );
          stats.items++;
        } else {
          stats.itemsDuplicity++;
        }
      }
      log.info(`Found ${requests.length} unique products`);

      // await all requests, so we don't end before they end
      await Promise.allSettled(requests);
      // Iterate all products and extract data
      await Apify.utils.sleep(getRandomInt(250, 950));
    }
  };

  const persistState = async () => {
    await Apify.setValue("STATS", stats).then(() => log.debug("STATS saved!"));
    log.info(JSON.stringify(stats));
  };
  Apify.events.on("persistState", persistState);

  log.info("ACTOR - setUp crawler");
  /** @type {ProxyConfiguration} */
  const proxyConfiguration = await Apify.createProxyConfiguration({
    groups: proxyGroups
  });

  const fingerprintGenerator = new FingerprintGenerator({
    devices: ["desktop"],
    browsers: [{ name: "firefox", minVersion: 88 }],
    operatingSystems: ["linux"]
  });

  const fingerprintInjector = new FingerprintInjector();
  const captchaSolver = new CaptchaSolver();
  // Create crawler
  const crawler = new Apify.PlaywrightCrawler({
    requestList,
    requestQueue,
    maxRequestRetries,
    proxyConfiguration,
    maxConcurrency,
    handleRequestTimeoutSecs: 300,
    handlePageTimeoutSecs: 300,
    navigationTimeoutSecs: 300,
    launchContext: {
      launchOptions: {
        headless: false
      },
      launcher: playwright.firefox
    },
    useSessionPool: true,
    preNavigationHooks: [
      async (context, gotoOptions) => {
        const { browserController, session, request, page } = context;
        const cookies = session.getPuppeteerCookies(request.url);
        const validCookies = cookies.filter(cookie => cookie.name);
        await browserController.setCookies(page, validCookies);

        await page.route("**/*", (route, request) => {
          const blockedResources = ["image", "media", "stylesheet", "font"];

          if (blockedResources.includes(request.resourceType())) {
            return route.abort().catch(() => {});
          }

          return route.continue().catch(() => {});
        });
      }
    ],
    postNavigationHooks: [
      async crawlingContext => {
        const { response, session, request, page } = crawlingContext;
        const isCaptcha = response.status() === 403;
        if (!isCaptcha) {
          log.info("No captcha");
          stats.pages++;
          session.setCookiesFromResponse(response);
          if (request.userData.label === LABELS.PAGE) {
            await page.waitForLoadState("networkidle", { timeout: 0 });
          }
          return;
        } else {
          log.warning("Captcha found");
          // solve using captcha solver .
          const [, recaptchaFrame] = await page.frames();
          await recaptchaFrame.waitForSelector("iframe[src*='/bframe']", {
            state: "attached"
          });
          const findSiteKey = () => {
            const bframe = document.querySelector("iframe[src*='/bframe']");
            const url = new URL(bframe.src);
            return url.searchParams.get("k");
          };

          const solution = await captchaSolver.getSolution(
            recaptchaFrame,
            session.userData.fingerprint.userAgent,
            findSiteKey
          );
          await recaptchaFrame.evaluate(solution => {
            grecaptcha.getResponse = () => solution;
            window.captchaCallback();
          }, solution);
          // DO not start the robotic logic right after solving
          await Apify.utils.sleep(10000);
          // Force the crawler to process the response by saying it is alright
          response.status = () => 200;
          log.info("Captcha solved!");
        }
      }
    ],
    sessionPoolOptions: {
      maxPoolSize: 12,
      createSessionFunction: async sessionPool => {
        const session = new Session({ sessionPool });
        session.userData.fingerprint =
          fingerprintGenerator.getFingerprint().fingerprint;
        return session;
      }
    },
    // we need custom cookie persistance because of malformed cookie format.
    persistCookiesPerSession: false,
    browserPoolOptions: {
      maxOpenPagesPerBrowser: 2,
      preLaunchHooks: [
        (pageId, launchContext) => {
          const { useIncognitoPages, launchOptions, session } = launchContext;
          const { fingerprint } = session.userData;
          launchContext.useIncognitoPages = true;

          if (useIncognitoPages) {
            return;
          }

          launchContext.launchOptions = {
            ...launchOptions,
            userAgent: fingerprint.userAgent,
            viewport: {
              width: fingerprint.screen.width,
              height: fingerprint.screen.height
            }
          };
        }
      ],
      prePageCreateHooks: [
        (pageId, browserController, pageOptions) => {
          const { launchContext } = browserController;
          const { fingerprint } = launchContext.session.userData;

          if (launchContext.useIncognitoPages && pageOptions) {
            pageOptions.userAgent = fingerprint.userAgent;
            pageOptions.viewport = {
              width: fingerprint.screen.width,
              height: fingerprint.screen.height
            };
          }
        }
      ],
      postPageCreateHooks: [
        async (page, browserController) => {
          const { browserPlugin, launchContext } = browserController;
          const { fingerprint } = launchContext.session.userData;

          if (browserPlugin instanceof PlaywrightPlugin) {
            const { useIncognitoPages, isFingerprintInjected } = launchContext;

            if (isFingerprintInjected) {
              // If not incognitoPages are used we would add the injection script over and over which could cause memory leaks.
              return;
            }
            const context = page.context();
            await fingerprintInjector.attachFingerprintToPlaywright(
              context,
              fingerprint
            );

            if (!useIncognitoPages) {
              // If not incognitoPages are used we would add the injection script over and over which could cause memory leaks.
              launchContext.extend({ isFingerprintInjected: true });
            }
          } else if (browserPlugin instanceof PuppeteerPlugin) {
            await fingerprintInjector.attachFingerprintToPuppeteer(
              page,
              fingerprint
            );
          }
        }
      ]
    },
    handlePageFunction,
    // This function is called if the page processing failed more than maxRequestRetries+1 times.
    handleFailedRequestFunction: async ({ request }) => {
      log.error(`Request ${request.url} failed ${maxRequestRetries} times`);
    }
  });

  const crawlerBasic = new Apify.BasicCrawler({
    requestQueue,
    maxConcurrency,
    maxRequestRetries,
    handleRequestFunction: async context => {
      const { request } = context;
      const { ids } = request.userData;
      const bodyList = "stiidlist=" + ids.join(",");

      const response = await gotScraping({
        url: "https://www.tsbohemia.cz/TsbStoitemPriceList_jx.asp",
        responseType: "json",
        proxyUrl: proxyConfiguration.newUrl(),
        "headers": {
          "accept": "*/*",
          "accept-language": "cs,en-US;q=0.9,en;q=0.8",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "sec-gpc": "1",
          "x-requested-with": "XMLHttpRequest",
          "Referrer-Policy": "strict-origin-when-cross-origin"
        },
        "body": bodyList,
        "method": "POST"
      });
      const { statusCode, body } = response;
      if (statusCode !== 200) {
        log.info(body.toString());
        throw new Error("Session blocked, retiring.");
      }
      const priceList = body.StoitemPriceList;
      const prices = [];
      if (priceList.length > 0) {
        for (const price of priceList) {
          const item = {};
          item.itemId = price.StiId;
          item.currentPrice = Math.round(
            (price.StiPrice + price.PriceRef + price.PriceRef2) *
              (1 + price.TaxRate / 100)
          );
          if (price.StiPrice === price.SipPrice0) {
            item.originalPrice = null;
            item.discounted = false;
          } else {
            item.originalPrice = Math.round(
              (price.SipPrice0 + price.PriceRef + price.PriceRef2) *
                (1 + price.TaxRate / 100)
            );
            item.discounted = true;
          }
          prices.push(item);
        }
        await Apify.pushData(prices);
        log.info(`Found ${prices.length}x items price`);
        stats.items += prices.length;
      }
    },
    handleFailedRequestFunction: async ({ request }) => {
      log.error(`Request ${request.url} failed multiple times`, request);
    }
  });

  // Run crawler
  log.info("ACTOR - Run crawler");
  if (type === LABELS.PRICE) {
    await crawlerBasic.run();
  } else {
    await crawler.run();
  }

  log.info("ACTOR - End crawler");

  await Apify.setValue("STATS", stats);
  log.debug("STATS saved!");
  log.info(JSON.stringify(stats));

  if (!development) {
    // calling the keboola upload
    let tableName = "tsbohemia";
    if (type === LABELS.PRICE) {
      tableName = `${tableName}_cz_price`;
    } else if (type === ActorType.BF) {
      tableName = `${tableName}_bf`;
    }
    await Promise.allSettled([
      invalidateCDN(cloudfront, "EQYSHWUECAQC9", "tsbohemia.cz"),
      uploadToKeboola(tableName)
    ]);
    log.info("invalidated Data CDN");
  }

  log.info("ACTOR - Finished");
});
