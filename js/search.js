// ============================================================================
//  关键词搜索修复版 (search.js)
//
//  故障现象：搜"庆余年"，第一屏却全是《"骗骗"喜欢你》《110米栏的天空》这类无关影片。
//
//  根因（实测上游采集站接口得到）：
//    1) 分页路径 &pg=N 在多数采集站的关键词搜索下是坏的：
//       pg=1 返回真正的搜索结果，pg>=2 直接返回整站"最新入库"列表。
//       原来的代码无条件抓到 API_CONFIG.search.maxPages（50）页并全部合并，
//       于是一个关键词能混进成百上千条无关影片。
//    2) 少数源（如"最大资源"）干脆忽略 wd 参数，任何关键词都返回整站列表，
//       而且它连第 1 页都是无关内容。
//    3) 结果最后按片名排序，无关影片反而排到了最前面 —— 用户看到的就是"搜索失效"。
//
//  修复方式：
//    · 每一页都按关键词做命中校验，只保留命中项；
//    · 某页命中为 0 就认定该源的分页失效，立即停止继续翻页（原来要打完 50 页）；
//    · 第 1 页命中为 0 则认定该源不支持关键词搜索，整源不返回（可在下面关掉）。
//
//  这是 /js/search.js 的直接替换文件，不需要改其它脚本。
// ============================================================================

const SEARCH_QUALITY_CONFIG = {
    maxPages: 5,                          // 关键词搜索最多翻几页（原来是 50 页）
    stopOnEmptyPage: true,                // 某页关键词命中为 0 → 停止翻页
    dropSourceWithoutKeywordSupport: true // 第 1 页命中为 0 → 丢弃整个源的结果
};

// 归一化：全角转半角、小写、去掉空白和标点，避免"庆余年 第二季"这类标题匹配不上
function normalizeForMatch(text) {
    if (text === null || text === undefined) return '';
    let str = String(text);
    try {
        str = str.normalize('NFKC');
    } catch (e) {
        // 老浏览器不支持 normalize 时忽略
    }
    return str
        .toLowerCase()
        .replace(/[\s\u00a0\u3000·,，、。．:：;；'"“”‘’《》<>()（）【】[\]\-—_/\\|]/g, '');
}

function getQueryTokens(query) {
    return String(query || '')
        .normalize('NFKC')
        .toLowerCase()
        .split(/\s+/)
        .map(t => normalizeForMatch(t))
        .filter(Boolean);
}

// 片名 / 主演 / 导演 任意一项命中关键词即算命中
function itemMatchesKeyword(item, tokens) {
    if (!tokens || tokens.length === 0) return true;
    const fields = [item && item.vod_name, item && item.vod_actor, item && item.vod_director]
        .map(normalizeForMatch)
        .filter(Boolean);
    const joined = tokens.join('');
    return fields.some(h => h.includes(joined) || tokens.every(t => h.includes(t)));
}

function filterPageResults(list, tokens) {
    if (!Array.isArray(list)) return [];
    return list.filter(item => itemMatchesKeyword(item, tokens));
}

function dedupeResults(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const key = (item.source_code || '') + '_' + (item.vod_id === undefined ? '' : item.vod_id);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

// 抓取一页搜索结果原始数据
async function fetchSearchPage(apiBaseUrl, query, page) {
    const pageUrl = page === 1
        ? apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query)
        : apiBaseUrl + API_CONFIG.search.pagePath
            .replace('{query}', encodeURIComponent(query))
            .replace('{page}', page);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
        const proxiedUrl = window.ProxyAuth && window.ProxyAuth.addAuthToProxyUrl
            ? await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(pageUrl))
            : PROXY_URL + encodeURIComponent(pageUrl);

        const response = await fetch(proxiedUrl, {
            headers: API_CONFIG.search.headers,
            signal: controller.signal
        });
        if (!response.ok) return { list: [], pageCount: 0 };

        const data = await response.json();
        const list = (data && Array.isArray(data.list)) ? data.list : [];
        const pageCount = (data && data.pagecount) ? Number(data.pagecount) || 1 : 1;
        return { list, pageCount };
    } catch (error) {
        console.warn(`搜索第${page}页失败:`, error && error.message ? error.message : error);
        return { list: [], pageCount: 0 };
    } finally {
        clearTimeout(timeoutId);
    }
}

async function searchByAPIAndKeyWord(apiId, query) {
    let apiUrl, apiName, apiBaseUrl;

    // 处理自定义API
    if (apiId.startsWith('custom_')) {
        const customIndex = apiId.replace('custom_', '');
        const customApi = getCustomApiInfo(customIndex);
        if (!customApi) return [];
        apiBaseUrl = customApi.url;
        apiName = customApi.name;
    } else {
        // 内置API
        if (!API_SITES[apiId]) return [];
        apiBaseUrl = API_SITES[apiId].api;
        apiName = API_SITES[apiId].name;
    }

    const decorate = (item) => ({
        ...item,
        source_name: apiName,
        source_code: apiId,
        api_url: apiId.startsWith('custom_') ? apiBaseUrl : undefined
    });

    const tokens = getQueryTokens(query);

    try {
        // ---- 第 1 页 ----
        const first = await fetchSearchPage(apiBaseUrl, query, 1);
        if (!first.list.length) return [];

        const firstMatched = filterPageResults(first.list, tokens);

        if (firstMatched.length === 0) {
            if (SEARCH_QUALITY_CONFIG.dropSourceWithoutKeywordSupport) {
                // 该源忽略 wd 参数（返回的是整站列表），整体丢弃
                console.warn(`[搜索] ${apiName} 返回的结果与"${query}"无关，判定该源不支持关键词搜索，已丢弃`);
                return [];
            }
            // 保底：无法判定时保留第一页原样结果
            return dedupeResults(first.list.map(decorate));
        }

        const results = firstMatched.map(decorate);

        // ---- 后续页：顺序请求，一旦某页没有命中就停止 ----
        const maxPage = Math.min(
            SEARCH_QUALITY_CONFIG.maxPages,
            Math.max(1, first.pageCount || 1)
        );

        for (let page = 2; page <= maxPage; page++) {
            const next = await fetchSearchPage(apiBaseUrl, query, page);
            if (!next.list.length) break;

            const matched = filterPageResults(next.list, tokens);
            if (matched.length === 0) {
                // 分页失效：pg>=2 返回的是整站最新列表，继续翻只会混进更多无关影片
                if (SEARCH_QUALITY_CONFIG.stopOnEmptyPage) {
                    console.info(`[搜索] ${apiName} 第${page}页与关键词无关，停止翻页`);
                    break;
                }
                continue;
            }
            results.push(...matched.map(decorate));
        }

        return dedupeResults(results);
    } catch (error) {
        console.warn(`API ${apiId} 搜索失败:`, error);
        return [];
    }
}
