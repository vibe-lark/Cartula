/**
 * Demo payload: the map Cartula opens with when no data has been written yet.
 *
 * Two itineraries through the Lesser and Greater Khingan ranges plus one layer
 * of candidate stops, so the workbench has something to show for layer
 * visibility, comparison, reordering, notes and the distance/day readouts.
 *
 * The coordinates are hand-placed WGS84 town/attraction centres, good to about
 * a kilometre — enough to look right on a basemap, not survey data. The legs
 * are drawn as straight lines between stops: this is a data demo, not a driving
 * plan, and no `path` is supplied precisely because Cartula never invents road
 * geometry. Each layer's `from` says so on screen.
 *
 * Layer ids are unique per map; point ids only per layer. The two routes both
 * use readable local ids, so `harbin` appearing under one route and `heihe`
 * under another is exactly the shape the API is meant to accept.
 */
import type { MapInput } from './types.js';

export const DEMO_INPUT: MapInput = {
  title: '大小兴安岭：两条北上路线',
  layers: [
    {
      id: 'lesser-khingan',
      name: '小兴安岭线：哈尔滨—黑河',
      kind: 'route',
      color: '#2563eb',
      crs: 'wgs84',
      from: '演示数据：坐标为手工标注的 WGS84 城镇中心（约千米级精度），路线按停靠顺序直线相连，不是真实驾车规划，也不代表道路可通行。',
      note: '沿小兴安岭东麓北上，森林与火山地貌为主，终点黑河与布拉戈维申斯克隔江相望。',
      routing: {
        source: '演示路由数据（示例值，非实时路况）',
        profile: 'driving',
        legs: [
          { fromPointId: 'harbin', toPointId: 'yichun', distanceKm: 325, durationMinutes: 245, profile: 'driving' },
          { fromPointId: 'yichun', toPointId: 'wudalianchi', distanceKm: 280, durationMinutes: 215 },
          { fromPointId: 'wudalianchi', toPointId: 'heihe', distanceKm: 250, durationMinutes: 190 },
        ],
      },
      points: [
        {
          id: 'harbin',
          name: '哈尔滨',
          at: [126.5300, 45.7975],
          day: 1,
          note: '出发地，太平机场与哈尔滨西站均可接入；建议在此补齐补给。',
        },
        {
          id: 'yichun',
          name: '伊春',
          at: [128.8347, 47.7256],
          day: 2,
          note: '小兴安岭林区中心，可就近安排汤旺河石林、五营森林公园。',
        },
        {
          id: 'wudalianchi',
          name: '五大连池',
          at: [126.2000, 48.5200],
          day: 4,
          note: '火山堰塞湖群，老黑山在市区北侧约 20 公里。',
        },
        {
          id: 'heihe',
          name: '黑河',
          at: [127.4920, 50.2420],
          day: 5,
          note: '中俄口岸城市，边境地区行程请提前确认通行与证件要求。',
          warn: true,
        },
      ],
    },
    {
      id: 'greater-khingan',
      name: '大兴安岭线：加格达奇—漠河',
      kind: 'route',
      color: '#e11d48',
      crs: 'wgs84',
      from: '演示数据：坐标为手工标注的 WGS84 城镇中心（约千米级精度），路线按停靠顺序直线相连，不是真实驾车规划，也不代表道路可通行。',
      note: '经根河绕行使鹿部落再北上漠河；纬度更高，冬季日照短、气温低。',
      routing: {
        source: '演示路由数据（示例值，非实时路况）',
        profile: 'driving',
        legs: [
          { fromPointId: 'jiagedaqi', toPointId: 'genhe', distanceKm: 215 },
          { fromPointId: 'genhe', toPointId: 'mohe', distanceKm: 345 },
        ],
      },
      points: [
        {
          id: 'jiagedaqi',
          name: '加格达奇',
          at: [124.1116, 50.4116],
          day: 1,
          note: '大兴安岭地区行署所在地，进出林区的铁路枢纽。',
        },
        {
          id: 'genhe',
          name: '根河',
          at: [121.5200, 50.7800],
          day: 3,
          note: '中国最冷城镇之一，与加格达奇之间为西向绕行，直线里程不等于实际路程。',
        },
        {
          id: 'mohe',
          name: '漠河',
          at: [122.5388, 52.9720],
          day: 5,
          note: '中国最北县级市，北极村在城区北侧约 80 公里。',
          warn: true,
        },
      ],
    },
    {
      id: 'candidate-spots',
      name: '候选景点',
      kind: 'spots',
      color: '#16a34a',
      crs: 'wgs84',
      visible: false,
      from: '演示数据：候选点位为手工标注的 WGS84 景点大致中心，未按行程排序，也未核对开放时间。',
      note: '尚未编入路线的备选点，可查看位置后添加到行程。',
      points: [
        { id: 'sophia', name: '圣索菲亚教堂', at: [126.6180, 45.7690], icon: 'museum', note: '哈尔滨市区内，适合出发日下午。' },
        { id: 'sun-island', name: '太阳岛', at: [126.5700, 45.7860], icon: 'park' },
        { id: 'stone-forest', name: '汤旺河石林', at: [129.4020, 48.4560], icon: 'viewpoint', note: '距伊春市区约 100 公里，宜整日安排。' },
        { id: 'wuying', name: '五营国家森林公园', at: [129.2400, 48.0980], icon: 'park' },
        { id: 'laoheishan', name: '老黑山', at: [126.1730, 48.7130], icon: 'viewpoint', note: '五大连池火山群主峰，步道往返约 2 小时。' },
        { id: 'daheihe', name: '大黑河岛', at: [127.4600, 50.2300], icon: 'park' },
        { id: 'aoluguya', name: '敖鲁古雅使鹿部落', at: [121.4650, 50.8180], icon: 'note', note: '根河市区西北，鄂温克驯鹿聚居地。' },
        { id: 'beijicun', name: '北极村', at: [122.3620, 53.4790], icon: 'viewpoint', note: '边境村落，进入需实名登记。', warn: true },
      ],
    },
  ],
};
