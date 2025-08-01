import { Router, Request, Response } from "express";
import { API_CONFIG, ApiSite, getApiSites, getCacheTime } from "../config";
import { cleanHtmlTags } from "../utils";

const router = Router();

// 根据环境变量决定最大搜索页数，默认 5
const MAX_SEARCH_PAGES: number = Number(process.env.SEARCH_MAX_PAGE) || 5;

export interface SearchResult {
  id: string;
  title: string;
  poster: string;
  episodes: string[];
  source: string;
  source_name: string;
  class?: string;
  year: string;
  desc?: string;
  type_name?: string;
}

interface ApiSearchItem {
  vod_id: string;
  vod_name: string;
  vod_pic: string;
  vod_remarks?: string;
  vod_play_url?: string;
  vod_class?: string;
  vod_year?: string;
  vod_content?: string;
  type_name?: string;
}

async function searchFromApi(
  apiSite: ApiSite,
  query: string
): Promise<SearchResult[]> {
  try {
    const apiBaseUrl = apiSite.api;
    const apiUrl =
      apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
    const apiName = apiSite.name;

    // 添加超时处理
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(apiUrl, {
      headers: API_CONFIG.search.headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return [];
    }

    const data = await response.json();

    console.log(
      "apiUrl",
      apiSite.name,
      "response status",
      response.ok,
      "response data",
      data.list.length
    );

    if (
      !data ||
      !data.list ||
      !Array.isArray(data.list) ||
      data.list.length === 0
    ) {
      return [];
    }
    // 处理第一页结果
    const results = data.list.map((item: ApiSearchItem) => {
      let episodes: string[] = [];

      // 使用正则表达式从 vod_play_url 提取 m3u8 链接
      if (item.vod_play_url) {
        const m3u8Regex = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
        // 先用 $$$ 分割
        const vod_play_url_array = item.vod_play_url.split("$$$");
        // 对每个分片做匹配，取匹配到最多的作为结果
        vod_play_url_array.forEach((url: string) => {
          const matches = url.match(m3u8Regex) || [];
          if (matches.length > episodes.length) {
            episodes = matches;
          }
        });
      }

      episodes = Array.from(new Set(episodes)).map((link: string) => {
        link = link.substring(1); // 去掉开头的 $
        const parenIndex = link.indexOf("(");
        return parenIndex > 0 ? link.substring(0, parenIndex) : link;
      });

      return {
        id: item.vod_id,
        title: item.vod_name,
        poster: item.vod_pic,
        episodes,
        source: apiSite.key,
        source_name: apiName,
        class: item.vod_class,
        year: item.vod_year ? item.vod_year.match(/\d{4}/)?.[0] || "" : "",
        desc: cleanHtmlTags(item.vod_content || ""),
        type_name: item.type_name,
      };
    });

    // 获取总页数
    const pageCount = data.pagecount || 1;
    // 确定需要获取的额外页数
    const pagesToFetch = Math.min(pageCount - 1, MAX_SEARCH_PAGES - 1);

    // 如果有额外页数，获取更多页的结果
    if (pagesToFetch > 0) {
      const additionalPagePromises = [];

      for (let page = 2; page <= pagesToFetch + 1; page++) {
        const pageUrl =
          apiBaseUrl +
          API_CONFIG.search.pagePath
            .replace("{query}", encodeURIComponent(query))
            .replace("{page}", page.toString());

        const pagePromise = (async () => {
          try {
            const pageController = new AbortController();
            const pageTimeoutId = setTimeout(
              () => pageController.abort(),
              8000
            );

            const pageResponse = await fetch(pageUrl, {
              headers: API_CONFIG.search.headers,
              signal: pageController.signal,
            });

            clearTimeout(pageTimeoutId);

            if (!pageResponse.ok) return [];

            const pageData = await pageResponse.json();

            if (!pageData || !pageData.list || !Array.isArray(pageData.list))
              return [];

            return pageData.list.map((item: ApiSearchItem) => {
              let episodes: string[] = [];

              if (item.vod_play_url) {
                const m3u8Regex = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
                episodes = item.vod_play_url.match(m3u8Regex) || [];
              }

              episodes = Array.from(new Set(episodes)).map((link: string) => {
                link = link.substring(1); // 去掉开头的 $
                const parenIndex = link.indexOf("(");
                return parenIndex > 0 ? link.substring(0, parenIndex) : link;
              });

              return {
                id: item.vod_id,
                title: item.vod_name,
                poster: item.vod_pic,
                episodes,
                source: apiSite.key,
                source_name: apiName,
                class: item.vod_class,
                year: item.vod_year
                  ? item.vod_year.match(/\d{4}/)?.[0] || ""
                  : "",
                desc: cleanHtmlTags(item.vod_content || ""),
                type_name: item.type_name,
              };
            });
          } catch (error) {
            return [];
          }
        })();

        additionalPagePromises.push(pagePromise);
      }

      const additionalResults = await Promise.all(additionalPagePromises);

      additionalResults.forEach((pageResults) => {
        if (pageResults.length > 0) {
          results.push(...pageResults);
        }
      });
    }

    return results;
  } catch (error) {
    return [];
  }
}

router.get("/", async (req: Request, res: Response) => {
  const query = req.query.q as string;

  if (!query) {
    const cacheTime = getCacheTime();
    res.setHeader("Cache-Control", `public, max-age=${cacheTime}`);
    return res.json({ results: [] });
  }

  const apiSites = getApiSites();
  const searchPromises = apiSites.map((site) => searchFromApi(site, query));

  try {
    const results = await Promise.all(searchPromises);
    const flattenedResults = results.flat();
    const cacheTime = getCacheTime();

    res.setHeader("Cache-Control", `public, max-age=${cacheTime}`);
    res.json({ results: flattenedResults });
  } catch (error) {
    res.status(500).json({ error: "搜索失败" });
  }
});

// 按资源 url 单个获取数据
router.get("/one", async (req: Request, res: Response) => {
  const { resourceId, q } = req.query;

  if (!resourceId || !q) {
    return res.status(400).json({ error: "resourceId and q are required" });
  }

  const apiSites = getApiSites();
  const apiSite = apiSites.find((site) => site.key === (resourceId as string));

  if (!apiSite) {
    return res.status(404).json({ error: "Resource not found" });
  }

  try {
    const results = await searchFromApi(apiSite, q as string);
    const result = results.filter((r) => r.title === (q as string));

    if (results) {
      const cacheTime = getCacheTime();
      res.setHeader("Cache-Control", `public, max-age=${cacheTime}`);
      res.json({results: result});
    } else {
      res.status(404).json({ error: "Resource not found with the given query" });
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch resource details" });
  }
});

// 获取所有可用的资源列表
router.get("/resources", async (req: Request, res: Response) => {
  const apiSites = getApiSites();
  const cacheTime = getCacheTime();
  res.setHeader("Cache-Control", `public, max-age=${cacheTime}`);
  res.json(apiSites);
});

export default router;
