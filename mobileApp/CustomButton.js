import React from 'react';
import {TouchableOpacity, Text, StyleSheet} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';

const CustomButton = ({title, onPress, size}) => (
  <TouchableOpacity
    style={[styles.buttonContainer, {width: size, height: size}]}
    onPress={onPress}>
    <LinearGradient
      colors={['#555555', '#AAAAAA']}
      style={styles.button}
      start={{x: 0, y: 0}}
      end={{x: 1, y: 1}}>
      <Text style={styles.buttonText}>{title}</Text>
    </LinearGradient>
  </TouchableOpacity>
);

const styles = StyleSheet.create({
  buttonContainer: {
    marginBottom: 10, // Adds vertical spacing between the tiles
  },
  button: {
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 10,
    flex: 1,
  },
  buttonText: {
    color: '#fff', // White text color
    fontSize: 16,
    fontWeight: 'bold',
  },
});

export default CustomButton;
