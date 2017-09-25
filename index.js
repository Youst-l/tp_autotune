import fs from 'fs-extra';
import path from 'path';
import _ from 'lodash';
import moment from 'moment';
import program from 'commander';
import promisify from 'es6-promisify';
import template from './profile_template.json';
import translateUtils from './util';

const exec = promisify(require('child_process').exec);

program
  .version('0.2.0')
  .option('--start-date <startDate>', 'YYYY-MM-DD')
  .option('--end-date <endDate>', 'YYYY-MM-DD')
  .option('--source <pathToJsonDump>', 'Path to the Tidepool JSON data.')
  .option(
    '-d, --no-docker',
    'Set flag to use globally installed oref0 executables instead of docker image.',
    true,
  )
  .option('-v, --verbose', 'Verbose console logging')
  .parse(process.argv);

const jsonPath =
  program.source || '../tidepool/command-line-data-tools/test.json';
const data = fs.readJsonSync(jsonPath);
const DATA_PATH = path.resolve('data');
const SETTINGS_PATH = path.join(DATA_PATH, 'settings');
const AUTOTUNE_PATH = path.join(DATA_PATH, 'autotune');

const GLUCOSE_MM = 18.01559;

const START_DATE =
  (program.startDate && moment(program.startDate).format('YYYY-MM-DD')) ||
  moment()
    .subtract(1, 'day')
    .format('YYYY-MM-DD');
const END_DATE =
  (program.endDate && moment(program.endDate).format('YYYY-MM-DD')) ||
  moment()
    .subtract(1, 'day')
    .format('YYYY-MM-DD');

const DATE_FILTER_START = moment.utc(START_DATE).subtract(4, 'hours');
const DATE_FILTER_END = moment.utc(END_DATE).add(1, 'day');

(async function main() {
  await fs.remove(DATA_PATH);
  await fs.mkdirp(SETTINGS_PATH);
  await fs.mkdirp(AUTOTUNE_PATH);

  const sortedData = _.sortBy(data, ['time']);

  // profile.json generation
  if (program.verbose) {
    console.log('Generating profile.json');
  }
  const pumpSettings = _.last(_.filter(sortedData, { type: 'pumpSettings' }));

  const { activeSchedule } = pumpSettings;
  const activeBasalSchedule = pumpSettings.basalSchedules[activeSchedule];

  const basalProfiles = _.map(activeBasalSchedule, sched => ({
    start: moment.utc(sched.start).format('HH:mm:ss'),
    minutes: moment.duration(sched.start).asMinutes(),
    rate: sched.rate,
  }));

  let isf;
  let carbRatio;

  if (pumpSettings.insulinSensitivities) {
    isf = translateUtils.getAverageISF(
      pumpSettings.insulinSensitivities[activeSchedule],
    );
  } else {
    isf = translateUtils.getAverageISF(pumpSettings.insulinSensitivity);
  }

  if (pumpSettings.carbRatios) {
    carbRatio = translateUtils.getAverageCarbRatio(
      pumpSettings.carbRatios[activeSchedule],
    );
  } else {
    carbRatio = translateUtils.getAverageCarbRatio(pumpSettings.carbRatio);
  }

  const profile = _.cloneDeep(template);
  profile.basalprofile = basalProfiles;
  profile.isfProfile.sensitivities[0].sensitivity = isf;
  profile.carb_ratio = carbRatio;

  const profilePath = path.join(SETTINGS_PATH, 'profile.json');

  await fs.writeFile(profilePath, JSON.stringify(profile, null, ' '));
  await fs.copy(profilePath, path.join(SETTINGS_PATH, 'pumpprofile.json'));
  await fs.copy(profilePath, path.join(SETTINGS_PATH, 'autotune.json'));
  await fs.copy(profilePath, path.join(AUTOTUNE_PATH, 'profile.pump.json'));
  await fs.copy(profilePath, path.join(AUTOTUNE_PATH, 'profile.json'));

  // CBG data translation
  if (program.verbose) {
    console.log('Translating CBG values');
  }
  const cbgData = _.filter(
    sortedData,
    datum =>
      datum.type === 'cbg' &&
      moment.utc(datum.time).isBetween(DATE_FILTER_START, DATE_FILTER_END),
  );
  const translatedCbgData = _.groupBy(
    _.map(cbgData, cbg => ({
      glucose: cbg.value * GLUCOSE_MM,
      date: cbg.time,
      dateString: cbg.time,
    })),
    cbg => moment.utc(cbg.date).format('YYYY-MM-DD'),
  );

  _.forOwn(translatedCbgData, async (dateData, date) => {
    await fs.writeFile(
      path.join(DATA_PATH, `tp-entries-${date}.json`),
      JSON.stringify(dateData, null, ' '),
    );
  });

  // treatment history translation
  if (program.verbose) {
    console.log('Translating pump history events');
  }
  const historyEvents = _.filter(
    sortedData,
    datum =>
      _.includes(['basal', 'bolus', 'wizard'], datum.type) &&
      // non-temp basal's are taken care of by the basal profiles
      (datum.type === 'basal' ? datum.deliveryType === 'temp' : true) &&
      moment.utc(datum.time).isBetween(DATE_FILTER_START, DATE_FILTER_END),
  );

  const translatedEvents = _.map(historyEvents, event => {
    switch (event.type) {
      case 'basal':
        return translateUtils.translateBasal(event);
      case 'bolus':
        return translateUtils.translateBolus(event);
      case 'wizard':
        return translateUtils.translateWizard(event);
      default:
        console.error('Unhandled event: ', event);
        throw new Error('Unknown event');
    }
  });

  await fs.writeFile(
    path.join(DATA_PATH, `tp-treatments.json`),
    JSON.stringify(translatedEvents, null, ' '),
  );
  let DOCKER_CMD = 'docker run -i -v "$(pwd)":/app pazaan/openaps ';
  let DOCKER_PREFIX = '/app/';

  if (!program.docker) {
    DOCKER_CMD = '';
    DOCKER_PREFIX = '';
  }

  // this loop is _very_ similar to what oref0-autotune does
  const currentDay = moment(START_DATE);
  while (currentDay.isSameOrBefore(END_DATE)) {
    const currentDayStr = currentDay.format('YYYY-MM-DD');
    if (program.verbose) {
      console.log(`Processing ${currentDayStr}`);
    }
    /* eslint-disable no-await-in-loop */
    await fs.copy(
      'data/autotune/profile.json',
      `data/autotune/profile.${currentDayStr}.json`,
    );
    await exec(
      `${DOCKER_CMD}oref0-autotune-prep ${DOCKER_PREFIX}data/tp-treatments.json ${DOCKER_PREFIX}data/autotune/profile.json ${DOCKER_PREFIX}data/tp-entries-${currentDayStr}.json > data/autotune.${currentDayStr}.json`,
    );
    await exec(
      `${DOCKER_CMD}oref0-autotune-core ${DOCKER_PREFIX}data/autotune.${currentDayStr}.json ${DOCKER_PREFIX}data/autotune/profile.json  ${DOCKER_PREFIX}data/autotune/profile.pump.json > data/newprofile.${currentDayStr}.json`,
    );
    await fs.copy(
      `data/newprofile.${currentDayStr}.json`,
      'data/autotune/profile.json',
    );
    await exec(
      `${DOCKER_CMD}oref0-autotune-recommends-report ${DOCKER_PREFIX}data`,
    );
    /* eslint-enable */
    currentDay.add(1, 'day');
  }
  console.log(
    await fs.readFile('data/autotune/autotune_recommendations.log', 'utf8'),
  );
})();
