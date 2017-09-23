import fs from 'fs-extra';
import path from 'path';
import template from './profile_template.json';
import _ from 'lodash';
import moment from 'moment';
import util from 'util';
import program from 'commander';
import promisify from 'es6-promisify';
const exec = promisify(require('child_process').exec);

program
  .version('0.0.1')
  .option('--start-date <startDate>', 'YYYY-MM-DD')
  .option('--end-date <endDate>', 'YYYY-MM-DD')
  .option('--source <pathToJsonDump>', 'Path to the Tidepool JSON data.')
  .option('-d, --no-docker', 'Set flag to use globally installed oref0 executables instead of docker image.', true)
  .parse(process.argv);

const jsonPath = program.pathToJsonDump || '../tidepool/command-line-data-tools/test.json';
const data = fs.readJsonSync(jsonPath);
const DATA_PATH = path.resolve('data');
const SETTINGS_PATH = path.join(DATA_PATH, 'settings');
const AUTOTUNE_PATH = path.join(DATA_PATH, 'autotune');

const GLUCOSE_MM = 18.01559;
const MS_PER_DAY = moment.duration({days:1}).asMilliseconds();

const START_DATE = program.startDate && moment(program.startDate).format('YYYY-MM-DD') || moment().subtract(1,'day').format('YYYY-MM-DD');
const END_DATE = program.endDate && moment(program.endDate).format('YYYY-MM-DD') || moment().subtract(1,'day').format('YYYY-MM-DD');

const DATE_FILTER_START = moment.utc(START_DATE).subtract(4,'hours');
const DATE_FILTER_END = moment.utc(END_DATE).add(1,'day');

async function main() {
  await fs.remove(DATA_PATH);
  await fs.mkdirp(SETTINGS_PATH);
  await fs.mkdirp(AUTOTUNE_PATH);

  const sortedData = _.sortBy(data, ['time']);

  // profile.json generation
  console.log('Generating profile.json');
  const pumpSettings = _.last(
    _.filter(sortedData, {type:'pumpSettings'})
  );

  const activeSchedule = pumpSettings.activeSchedule;
  const activeBasalSchedule = pumpSettings.basalSchedules[activeSchedule];

  const basalProfiles = _.map(activeBasalSchedule, (sched) => {
    return {
      start: moment.utc(sched.start).format('HH:mm:ss'),
      minutes: moment.duration(sched.start).asMinutes(),
      rate: sched.rate
    }
  });

  let isf, carb_ratio;

  if(pumpSettings.insulinSensitivities){
    isf = getAverageISF(pumpSettings.insulinSensitivities[activeSchedule]);
  } else {
    isf = getAverageISF(pumpSettings.insulinSensitivity);
  }

  if(pumpSettings.carbRatios){
    carb_ratio = getAverageCarbRatio(pumpSettings.carbRatios[activeSchedule]);
  } else {
    carb_ratio = getAverageCarbRatio(pumpSettings.carbRatio);
  }

  const profile = _.cloneDeep(template);
  profile.basalprofile = basalProfiles;
  profile.isfProfile.sensitivities[0].sensitivity = isf;
  profile.carb_ratio = carb_ratio;

  const profile_path = path.join(SETTINGS_PATH, 'profile.json');

  await fs.writeFile(profile_path, JSON.stringify(profile, null, ' '));
  await fs.copy(profile_path, path.join(SETTINGS_PATH, 'pumpprofile.json'));
  await fs.copy(profile_path, path.join(SETTINGS_PATH, 'autotune.json'));
  await fs.copy(profile_path, path.join(AUTOTUNE_PATH, 'profile.pump.json'));
  await fs.copy(profile_path, path.join(AUTOTUNE_PATH, 'profile.json'));

  // CBG data translation
  console.log('Translating CBG values');
  const cbgData = _.filter(sortedData, (datum) => {
    return datum.type === 'cbg' &&
      moment.utc(datum.time).isBetween(DATE_FILTER_START, DATE_FILTER_END);
  });
  const translatedCbgData = _.groupBy(_.map(cbgData, (cbg) => {
    return {
      'glucose': cbg.value * GLUCOSE_MM,
      'date': cbg.time,
      'dateString': cbg.time
    }
  }), (cbg) => moment.utc(cbg.date).format('YYYY-MM-DD'));

  _.forOwn(translatedCbgData, async (data, date) => {
    await fs.writeFile(
      path.join(DATA_PATH, `tp-entries-${date}.json`),
      JSON.stringify(data, null, ' ')
    );
  });

  // treatment history translation
  console.log('Translating pump history events');
  const historyEvents = _.filter(sortedData, (data) => {
    return _.includes(['basal', 'bolus', 'wizard'], data.type) &&
      // non-temp basal's are taken care of by the basal profiles
      (data.type === 'basal' ? data.deliveryType === 'temp' : true) &&
      moment.utc(data.time).isBetween(DATE_FILTER_START, DATE_FILTER_END);
  });

  const translatedEvents = _.map(historyEvents, (event) => {
    switch (event.type) {
      case 'basal':
        return translateBasal(event);
        break;
      case 'bolus':
        return translateBolus(event);
        break;
      case 'wizard':
        return translateWizard(event);
        break;
      default:
        console.error('Unhandled event: ',event);
    }
  });

  await fs.writeFile(
    path.join(DATA_PATH, `tp-treatments.json`),
    JSON.stringify(translatedEvents, null, ' ')
  );
  let DOCKER_CMD = 'docker run -i -v "$(pwd)":/app pazaan/openaps ';
  let DOCKER_PREFIX = '/app/';

  if(!program.docker){
    DOCKER_CMD = '';
    DOCKER_PREFIX = '';
  }

  // this loop is _very_ similar to what oref0-autotune does
  const currentDay = moment(START_DATE);
  while(currentDay.isSameOrBefore(END_DATE)){
    const currentDayStr = currentDay.format('YYYY-MM-DD');
    console.log(`Processing ${currentDayStr}`);
    // oref0-autotune-prep ./data/tp-treatments.json ./data/settings/profile.json ./data/tp-entries-2017-09-12.json > ./data/autotune.2017-09-12.json
    // oref0-autotune-core data/autotune.2017-09-12.json data/settings/profile.json  data/autotune/profile.pump.json > data/newprofile.json
    // cp data/autotune/newprofile.2017-09-12.json data/autotune/profile.json
    // oref0-autotune-recommends-report data
    await fs.copy('data/autotune/profile.json', `data/autotune/profile.${currentDayStr}.json`);
    await exec(`${DOCKER_CMD}oref0-autotune-prep ${DOCKER_PREFIX}data/tp-treatments.json ${DOCKER_PREFIX}data/autotune/profile.json ${DOCKER_PREFIX}data/tp-entries-${currentDayStr}.json > data/autotune.${currentDayStr}.json`);
    await exec(`${DOCKER_CMD}oref0-autotune-core ${DOCKER_PREFIX}data/autotune.${currentDayStr}.json ${DOCKER_PREFIX}data/autotune/profile.json  ${DOCKER_PREFIX}data/autotune/profile.pump.json > data/newprofile.${currentDayStr}.json`);
    await fs.copy(`data/newprofile.${currentDayStr}.json`, 'data/autotune/profile.json');
    await exec(`${DOCKER_CMD}oref0-autotune-recommends-report ${DOCKER_PREFIX}data`);
    currentDay.add(1,'day');
  }
console.log(await fs.readFile('data/autotune/autotune_recommendations.log', 'utf8'));
};

main();

// util functions

function translateBasal(basal) {
  return {
    eventType: "Temp Basal",
    timestamp: basal.time,
    rate: basal.rate,
    duration: moment.duration(basal.duration).asMinutes()
  }
}

function translateBolus(bolus) {
  return {
    eventType: "Bolus",
    timestamp: bolus.time,
    amount: bolus.normal
  }
}

function translateWizard(wizard) {
  return {
    // _type vs eventType here because it allows for carb input
    // without needing an insulin bolus (since tidepool's data model)
    // has the bolus separate and it's less effort to try and reassemble
    // them here - the bolus gets picked up separately
    _type: "Bolus Wizard",
    timestamp: wizard.time,
    carbs: wizard.carbInput
  }
}

function getAverageISF(insulinSensitivity) {
  let total_isf = 0;
  _.forEach(insulinSensitivity, (isf, i, arr) => {
    let end, dur;
    if(i < arr.length - 1) {
      end = arr[i+1].start;
    } else {
      end = MS_PER_DAY;
    }
    dur = moment.duration(end - isf.start).asMilliseconds();
    total_isf += dur * isf.amount;
  });
  let avg_isf = total_isf / MS_PER_DAY * GLUCOSE_MM;
  return avg_isf;
}

function getAverageCarbRatio(carbRatio) {
  let total_carb_ratio = 0;
  _.forEach(carbRatio, (cr, i, arr) => {
    let end, dur;
    if(i < arr.length - 1) {
      end = arr[i+1].start;
    } else {
      end = MS_PER_DAY;
    }
    dur = moment.duration(end - cr.start).asMilliseconds();
    total_carb_ratio += dur * cr.amount;
  });
  let avg_carb_ratio = total_carb_ratio / MS_PER_DAY;
  return avg_carb_ratio;
};
