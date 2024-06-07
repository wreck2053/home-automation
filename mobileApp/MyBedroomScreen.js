import React, {useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  StatusBar,
  Modal,
  TouchableOpacity,
  Dimensions,
} from 'react-native';
import {Slider} from 'react-native-elements';
import CustomButton from './CustomButton';

const MyBedroomScreen = () => {
  const [isTemperatureModalVisible, setTemperatureModalVisible] =
    useState(false);
  const [isFanSpeedModalVisible, setFanSpeedModalVisible] = useState(false);
  const [temperature, setTemperature] = useState(22);
  const [fanSpeed, setFanSpeed] = useState(1);

  const sendCommand = command => {
    fetch(`http://192.168.0.102${command}`)
      .then(response => console.log(response))
      .catch(error => console.error(error));
  };

  const toggleTemperatureModal = () => {
    setTemperatureModalVisible(!isTemperatureModalVisible);
  };

  const toggleFanSpeedModal = () => {
    setFanSpeedModalVisible(!isFanSpeedModalVisible);
  };

  const handleTemperatureChange = value => {
    setTemperature(value);
  };

  const handleFanSpeedChange = value => {
    setFanSpeed(value);
  };

  const handleTemperatureConfirm = () => {
    sendCommand(`/temp/set/${Math.round(temperature)}`);
    toggleTemperatureModal();
  };

  const handleFanSpeedConfirm = () => {
    // sendCommand(`/fan/${Math.round(fanSpeed)}`);
    if (fanSpeed === 1) sendCommand('/fan/low');
    else if (fanSpeed === 2) sendCommand('/fan/med');
    else if (fanSpeed === 3) sendCommand('/fan/high');
    toggleFanSpeedModal();
  };

  const {width} = Dimensions.get('window');
  const tileSize = width / 2 - 30;

  return (
    <>
      <StatusBar barStyle="light-content" />
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scrollView}>
          <View style={styles.tilesContainer}>
            <View style={styles.column}>
              <CustomButton
                title="Toggle Light"
                onPress={() => sendCommand('/toggle-light')}
                size={tileSize}
              />
              <CustomButton
                title="Power On AC"
                onPress={() => sendCommand('/power/on')}
                size={tileSize}
              />
              <CustomButton
                title="Set Temperature"
                onPress={toggleTemperatureModal}
                size={tileSize}
              />
              <CustomButton
                title="Cool Mode"
                onPress={() => sendCommand('/mode/cool')}
                size={tileSize}
              />
              <CustomButton
                title="Swing"
                onPress={() => sendCommand('/state/swing')}
                size={tileSize}
              />
            </View>
            <View style={styles.column}>
              <CustomButton
                title="Toggle Fan"
                onPress={() => sendCommand('/toggle-fan')}
                size={tileSize}
              />
              <CustomButton
                title="Power Off AC"
                onPress={() => sendCommand('/power/off')}
                size={tileSize}
              />
              <CustomButton
                title="Set Fan Speed"
                onPress={toggleFanSpeedModal}
                size={tileSize}
              />
              <CustomButton
                title="Turbo"
                onPress={() => sendCommand('/state/turbo')}
                size={tileSize}
              />
              <CustomButton
                title="Toggle LED"
                onPress={() => sendCommand('/state/led')}
                size={tileSize}
              />
            </View>
          </View>
        </ScrollView>
      </View>

      {/* Temperature Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={isTemperatureModalVisible}
        onRequestClose={toggleTemperatureModal}>
        <View style={styles.modalContainer}>
          <View style={styles.modalContent}>
            <Text style={styles.modalHeading}>
              Set Temperature: {Math.round(temperature)}°C
            </Text>
            <Slider
              value={temperature}
              onValueChange={handleTemperatureChange}
              minimumValue={17}
              maximumValue={30}
              step={1}
              thumbTintColor="#777777"
              minimumTrackTintColor="#777777"
              maximumTrackTintColor="#000000"
              style={styles.slider}
            />
            <TouchableOpacity
              onPress={handleTemperatureConfirm}
              style={styles.confirmButton}>
              <Text style={styles.confirmButtonText}>Confirm</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={toggleTemperatureModal}
              style={styles.closeButton}>
              <Text style={styles.closeButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Fan Speed Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={isFanSpeedModalVisible}
        onRequestClose={toggleFanSpeedModal}>
        <View style={styles.modalContainer}>
          <View style={styles.modalContent}>
            <Text style={styles.modalHeading}>
              Set Fan Speed: {Math.round(fanSpeed)}
            </Text>
            <Slider
              value={fanSpeed}
              onValueChange={handleFanSpeedChange}
              minimumValue={1}
              maximumValue={3}
              step={1}
              thumbTintColor="#777777"
              minimumTrackTintColor="#777777"
              maximumTrackTintColor="#000000"
              style={styles.slider}
            />
            <TouchableOpacity
              onPress={handleFanSpeedConfirm}
              style={styles.confirmButton}>
              <Text style={styles.confirmButtonText}>Confirm</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={toggleFanSpeedModal}
              style={styles.closeButton}>
              <Text style={styles.closeButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#434343',
  },
  scrollView: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  tilesContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  column: {
    flex: 1,
  },
  heading1: {
    color: '#f4f4f9',
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  modalContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  modalContent: {
    width: '80%',
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  modalHeading: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 20,
    color: 'black',
  },
  slider: {
    width: '100%',
    height: 40,
  },
  confirmButton: {
    backgroundColor: '#000000',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 10,
    marginTop: 20,
  },
  confirmButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  closeButton: {
    backgroundColor: '#777777',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 10,
    marginTop: 10,
  },
  closeButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});

export default MyBedroomScreen;
