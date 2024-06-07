import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  Dimensions,
} from 'react-native';

const HomeScreen = ({navigation}) => {
  const {width} = Dimensions.get('window');
  const tileSize = width / 2 - 30;

  return (
    <>
      <StatusBar barStyle="light-content" />
      <View style={styles.container}>
        <TouchableOpacity
          style={[styles.tile, {width: tileSize, height: tileSize}]}
          onPress={() => navigation.navigate('MyBedroom')}>
          <Text style={styles.tileText}>My Bedroom</Text>
        </TouchableOpacity>
      </View>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#434343',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heading: {
    color: '#f4f4f9',
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  tile: {
    backgroundColor: '#777777',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    margin: 10,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  tileText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
});

export default HomeScreen;
