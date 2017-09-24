import moment from 'moment';
import _ from 'lodash';

const MS_PER_DAY = moment.duration({ days: 1 }).asMilliseconds();
const GLUCOSE_MM = 18.01559;

function translateBasal(basal) {
  return {
    eventType: 'Temp Basal',
    timestamp: basal.time,
    rate: basal.rate,
    duration: moment.duration(basal.duration).asMinutes(),
  };
}

function translateBolus(bolus) {
  return {
    eventType: 'Bolus',
    timestamp: bolus.time,
    amount: bolus.normal,
  };
}

function translateWizard(wizard) {
  return {
    // _type vs eventType here because it allows for carb input
    // without needing an insulin bolus (since tidepool's data model)
    // has the bolus separate and it's less effort to try and reassemble
    // them here - the bolus gets picked up separately
    _type: 'Bolus Wizard',
    timestamp: wizard.time,
    carbs: wizard.carbInput,
  };
}

function getAverageISF(insulinSensitivity) {
  let totalIsf = 0;
  _.forEach(insulinSensitivity, (isf, i, arr) => {
    let end;
    if (i < arr.length - 1) {
      end = arr[i + 1].start;
    } else {
      end = MS_PER_DAY;
    }
    const dur = moment.duration(end - isf.start).asMilliseconds();
    totalIsf += dur * isf.amount;
  });
  const avgIsf = totalIsf / MS_PER_DAY * GLUCOSE_MM;
  return avgIsf;
}

function getAverageCarbRatio(carbRatio) {
  let totalCarbRatio = 0;
  _.forEach(carbRatio, (cr, i, arr) => {
    let end;
    if (i < arr.length - 1) {
      end = arr[i + 1].start;
    } else {
      end = MS_PER_DAY;
    }
    const dur = moment.duration(end - cr.start).asMilliseconds();
    totalCarbRatio += dur * cr.amount;
  });
  const avgCarbRatio = totalCarbRatio / MS_PER_DAY;
  return avgCarbRatio;
}

export default {
  translateBasal,
  translateBolus,
  translateWizard,
  getAverageCarbRatio,
  getAverageISF,
};
