import axios from "axios";
import qs from "qs";
import lodash from "lodash";
import isNil from "lodash/isNil.js";
import retry from "async-retry";
import get from "lodash/get.js";

export default {
  type: "app",
  app: "reddit",
  propDefinitions: {
    after: {
      type: "string",
      label: "After",
      description: "Only one of `after` and `before` should be specified. These indicate the [fullname](https://www.reddit.com/dev/api/#fullnames) of an item in the listing to use as the anchor point of the slice.",
      optional: true,
    },
    before: {
      type: "string",
      label: "Before",
      description: "Only one of `after` and `before` should be specified. These indicate the [fullname](https://www.reddit.com/dev/api/#fullnames) of an item in the listing to use as the anchor point of the slice.",
      optional: true,
    },
    count: {
      type: "integer",
      label: "Count",
      description: "The number of items already seen in this listing. on the html site, the builder uses this to determine when to give values for `before` and `after` in the response.",
      optional: true,
    },
    limit: {
      type: "integer",
      label: "Limit",
      description: "Default to 25. The maximum number of items desired",
      min: 1,
      max: 100,
      optional: true,
    },
    subreddit: {
      type: "string",
      label: "Subreddit",
      description: "The subreddit you'd like to watch.",
      useQuery: true,
      async options(context) {
        const q = context.query;
        const options = [];
        const results = await this.getAllSearchSubredditsResults(q);
        for (const subreddit of results) {
          options.push({
            label: subreddit.title,
            value: subreddit.displayName,
          });
        }
        return options;
      },
    },
    username: {
      type: "string",
      label: "Username",
      description: "The username you'd like to watch.",
    },
    timeFilter: {
      type: "string",
      label: "Time filter",
      description:
        "If set to all, all existing links or comments, before applying dedupe strategy, will be considered to be emitted. Otherwise, the indicated time frame will be used for getting links or comments.",
      options: [
        "hour",
        "day",
        "week",
        "month",
        "year",
        "all",
      ],
      default: "all",
      optional: true,
    },
    includeSubredditDetails: {
      type: "boolean",
      label: "Include subreddit details?",
      description:
        "If set to true, subreddit details will be expanded/included in the emitted event.",
      default: false,
      optional: true,
    },
  },
  methods: {
    _getAxiosParams(opts) {
      const res = {
        ...opts,
        url: this._apiUrl() + opts.path + this._getQuery(opts.params),
        headers: this._getHeaders(),
        data: opts.data && qs.stringify(opts.data),
      };
      return res;
    },
    _getQuery(params) {
      if (!params) {
        return "";
      }

      let query = "?";
      const keys = Object.keys(params);
      for (let i = 0; i < keys.length; i++) {
        // Explicity looking for nil values to avoid false negative for Boolean(false)
        if (!isNil(params[keys[i]])) {
          query += `${keys[i]}=${params[keys[i]]}&`;
        }
      }

      // It removes the last string char, it can be ? or &
      return query.substr(0, query.length - 1);
    },
    _getHeaders() {
      return {
        "authorization": `Bearer ${this._accessToken()}`,
        "user-agent": "@PipedreamHQ/pipedream v0.1",
      };
    },
    _accessToken() {
      return this.$auth.oauth_access_token;
    },
    _apiUrl() {
      return "https://oauth.reddit.com";
    },
    sanitizeError(data) {
      // Check mod required error
      if (get(
        JSON.stringify(data).match(/(MOD_OF_THIS_SR_REQUIRED)/),
        "[0]",
      )) {
        throw new Error("You must be a moderator of this SubReddit to do that");
      }

      // Check already posted
      if (get(
        JSON.stringify(data).match(/(ALREADY_SUB)/),
        "[0]",
      )) {
        throw new Error("This community doesn't allow links to be posted more than once, and this link has already been shared");
      }

      // Find event limit error
      const eventLimitMessage = get(
        JSON.stringify(data).match(/(This event can't be longer than \S*\d+\S* days)/),
        "[0]",
      );

      if (eventLimitMessage) {
        throw new Error(eventLimitMessage);
      }

      // Find rate limit error
      const rateLimitMessage = get(
        JSON.stringify(data).match(/(\S*\d+\S* minute)/),
        "[0]",
      );

      if (rateLimitMessage) {
        throw new Error(`Reddit rate-limit: Please wait ${rateLimitMessage}(s) before post again.`);
      }
    },
    async _makeRequest(opts) {
      if (!opts.headers) opts.headers = {};
      opts.headers.authorization = `Bearer ${this._accessToken()}`;
      opts.headers["user-agent"] = "@PipedreamHQ/pipedream v0.1";
      const { path } = opts;
      delete opts.path;
      opts.url = `${this._apiUrl()}${path[0] === "/" ?
        "" :
        "/"}${path}`;
      return (await axios(opts)).data;
    },
    _isRetriableStatusCode(statusCode) {[
      408,
      429,
      500,
    ].includes(statusCode);
    },
    async _withRetries(apiCall) {
      const retryOpts = {
        retries: 5,
        factor: 2,
      };
      return retry(async (bail) => {
        try {
          return await apiCall();
        } catch (err) {
          const statusCode = get(err, [
            "response",
            "status",
          ]);
          if (!this._isRetriableStatusCode(statusCode)) {
            bail(`
              Unexpected error (status code: ${statusCode}):
              ${err.response}
            `);
          }
          console.warn(`Temporary error: ${err.message}`);
          throw err;
        }
      }, retryOpts);
    },
    /**
     * This method retrieves the most recent new hot subreddit posts. The
     * returned dataset contains at most `opts.limit` entries.
     *
     * @param {string}  subreddit the subreddit from which to retrieve the
     * hot posts
     * @param {enum}    region the region from where to retrieve the hot
     * posts (e.g. `GLOBAL`, `US`, `AR`, etc.). See the `g` parameter in the
     * docs for more information: https://www.reddit.com/dev/api/#GET_hot
     * @param {boolean} [excludeFilters=false] if set to `true`, filters
     * such as "hide links that I have voted on" will be disabled
     * @param {boolean} [includeSubredditDetails=false] whether the
     * subreddit details should be expanded/included or not
     * @param {number}  [limit=100] the maximum amount of posts to retrieve
     * @returns the list of new hot posts belonging to the specified subreddit
     */
    async getNewHotSubredditPosts(
      subreddit,
      region,
      excludeFilters,
      includeSubredditDetails,
      limit = 100,
    ) {
      const params = {};
      if (excludeFilters) {
        params["show"] = "all";
      }
      params["g"] = region;
      params["sr_detail"] = includeSubredditDetails;
      params["limit"] = limit;
      return await this._withRetries(() =>
        this._makeRequest({
          path: `/r/${subreddit}/hot`,
          params,
        }));
    },
    async getNewSubredditLinks(before, subreddit, limit = 100) {
      const params = {
        before,
        limit,
      };
      return await this._withRetries(() =>
        this._makeRequest({
          path: `/r/${subreddit}/new`,
          params,
        }));
    },
    async getNewSubredditComments(
      subreddit,
      subredditPost,
      numberOfParents,
      depth,
      includeSubredditDetails,
      limit = 100,
    ) {
      const params = {
        article: subredditPost,
        context: numberOfParents,
        depth,
        limit,
        sort: "new",
        sr_detail: includeSubredditDetails,
        theme: "default",
        threaded: true,
        trucate: 0,
      };
      const [
        ,
        redditComments,
      ] = await this._withRetries(() =>
        this._makeRequest({
          path: `/r/${subreddit}/comments/article`,
          params,
        }));
      return redditComments;
    },
    async getNewUserLinks(
      before,
      username,
      numberOfParents,
      timeFilter,
      includeSubredditDetails,
      limit = 100,
    ) {
      const params = {
        before,
        context: numberOfParents,
        show: "given",
        sort: "new",
        t: timeFilter,
        type: "links",
        sr_detail: includeSubredditDetails,
        limit,
      };
      return await this._withRetries(() =>
        this._makeRequest({
          path: `/user/${username}/submitted`,
          params,
        }));
    },
    async getNewUserComments(
      before,
      username,
      numberOfParents,
      timeFilter,
      includeSubredditDetails,
      limit = 100,
    ) {
      const params = {
        before,
        context: numberOfParents,
        show: "given",
        sort: "new",
        t: timeFilter,
        type: "comments",
        sr_detail: includeSubredditDetails,
        limit,
      };
      return await this._withRetries(() =>
        this._makeRequest({
          path: `/user/${username}/comments`,
          params,
        }));
    },
    async searchSubreddits(params) {
      const redditCommunities = await this._withRetries(() =>
        this._makeRequest({
          path: "/subreddits/search",
          params,
        }));
      return redditCommunities;
    },
    async getAllSearchSubredditsResults(query) {
      const results = [];
      let after = null;
      do {
        const redditCommunities = await this.searchSubreddits({
          after,
          q: query,
          limit: 100,
          show_users: false,
          sort: "relevance",
          sr_detail: false,
          typeahead_active: false,
        });
        const isNewDataAvailable = lodash.get(redditCommunities, [
          "data",
          "children",
          "length",
        ]);
        if (!isNewDataAvailable) {
          break;
        }
        const { children: communities = [] } = redditCommunities.data;
        after = communities[communities.length - 1].data.name;
        communities.forEach((subreddit) => {
          const {
            title,
            display_name: displayName,
          } = subreddit.data;
          results.push({
            title,
            displayName,
          });
        });
      } while (after);
      return results;
    },
  },
};
